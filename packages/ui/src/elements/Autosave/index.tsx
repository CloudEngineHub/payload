'use client'
// TODO: abstract the `next/navigation` dependency out from this component
import type { ClientCollectionConfig, ClientGlobalConfig } from 'payload'

import { versionDefaults } from 'payload/shared'
import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  useAllFormFields,
  useForm,
  useFormModified,
  useFormSubmitted,
} from '../../forms/Form/context.js'
import { useDebounce } from '../../hooks/useDebounce.js'
import { useEffectEvent } from '../../hooks/useEffectEvent.js'
import { useConfig } from '../../providers/Config/index.js'
import { useDocumentEvents } from '../../providers/DocumentEvents/index.js'
import { useDocumentInfo } from '../../providers/DocumentInfo/index.js'
import { useLocale } from '../../providers/Locale/index.js'
import { useTranslation } from '../../providers/Translation/index.js'
import './index.scss'
import { formatTimeToNow } from '../../utilities/formatDate.js'
import { reduceFieldsToValuesWithValidation } from '../../utilities/reduceFieldsToValuesWithValidation.js'
import { LeaveWithoutSaving } from '../LeaveWithoutSaving/index.js'

const baseClass = 'autosave'
// The minimum time the saving state should be shown
const minimumAnimationTime = 1000

export type Props = {
  collection?: ClientCollectionConfig
  global?: ClientGlobalConfig
  id?: number | string
  publishedDocUpdatedAt: string
}

export const Autosave: React.FC<Props> = ({ id, collection, global: globalDoc }) => {
  const {
    config: {
      routes: { api },
      serverURL,
    },
  } = useConfig()
  const {
    docConfig,
    incrementVersionCount,
    lastUpdateTime,
    mostRecentVersionIsAutosaved,
    setLastUpdateTime,
    setMostRecentVersionIsAutosaved,
    setUnpublishedVersionCount,
    updateSavedDocumentData,
  } = useDocumentInfo()
  const queueRef = useRef([])
  const isProcessingRef = useRef(false)

  const { reportUpdate } = useDocumentEvents()
  const { dispatchFields, isValid, setIsValid, setSubmitted } = useForm()

  const [fields] = useAllFormFields()
  const modified = useFormModified()
  const submitted = useFormSubmitted()

  const { code: locale } = useLocale()
  const { i18n, t } = useTranslation()

  const versionsConfig = docConfig?.versions
  let interval = versionDefaults.autosaveInterval

  if (versionsConfig.drafts && versionsConfig.drafts.autosave) {
    interval = versionsConfig.drafts.autosave.interval
  }

  const validateOnDraft = Boolean(
    docConfig?.versions?.drafts && docConfig?.versions?.drafts.validate,
  )

  const [saving, setSaving] = useState(false)
  const debouncedFields = useDebounce(fields, interval)
  const fieldRef = useRef(fields)
  const modifiedRef = useRef(modified)
  const localeRef = useRef(locale)
  /**
   * Track the validation internally so Autosave can determine when to run queue processing again
   * Helps us prevent infinite loops when the queue is processing and the form is invalid
   */
  const isValidRef = useRef(isValid)
  const debouncedRef = useRef(debouncedFields)

  debouncedRef.current = debouncedFields

  // Store fields in ref so the autosave func
  // can always retrieve the most to date copies
  // after the timeout has executed
  fieldRef.current = fields

  // Store modified in ref so the autosave func
  // can bail out if modified becomes false while
  // timing out during autosave
  modifiedRef.current = modified

  // Store locale in ref so the autosave func
  // can always retrieve the most to date locale
  localeRef.current = locale

  const processQueue = React.useCallback(async () => {
    if (isProcessingRef.current || queueRef.current.length === 0) {
      return
    }

    if (!isValidRef.current) {
      // Clear queue so we don't end up in an infinite loop
      queueRef.current = []
      // Reset internal validation state so queue processing can run again
      isValidRef.current = true
      return
    }

    isProcessingRef.current = true
    const latestAction = queueRef.current[queueRef.current.length - 1]
    queueRef.current = []

    try {
      await latestAction()
    } finally {
      isProcessingRef.current = false
      if (queueRef.current.length > 0) {
        await processQueue()
      }
    }
  }, [])

  const handleAutosave = useEffectEvent(() => {
    const abortController = new AbortController()
    let autosaveTimeout = undefined
    // We need to log the time in order to figure out if we need to trigger the state off later
    let startTimestamp = undefined
    let endTimestamp = undefined

    const autosave = async () => {
      if (modified) {
        startTimestamp = new Date().getTime()

        setSaving(true)

        let url: string
        let method: string
        let entitySlug: string

        if (collection && id) {
          entitySlug = collection.slug
          url = `${serverURL}${api}/${entitySlug}/${id}?draft=true&autosave=true&locale=${localeRef.current}`
          method = 'PATCH'
        }

        if (globalDoc) {
          entitySlug = globalDoc.slug
          url = `${serverURL}${api}/globals/${entitySlug}?draft=true&autosave=true&locale=${localeRef.current}`
          method = 'POST'
        }

        if (url) {
          if (modifiedRef.current) {
            const { data, valid } = {
              ...reduceFieldsToValuesWithValidation(fieldRef.current, true),
            }
            data._status = 'draft'
            const skipSubmission =
              submitted && !valid && versionsConfig?.drafts && versionsConfig?.drafts?.validate

            if (!skipSubmission && isValidRef.current) {
              await fetch(url, {
                body: JSON.stringify(data),
                credentials: 'include',
                headers: {
                  'Accept-Language': i18n.language,
                  'Content-Type': 'application/json',
                },
                method,
                signal: abortController.signal,
              })
                .then((res) => {
                  const newDate = new Date()
                  // We need to log the time in order to figure out if we need to trigger the state off later
                  endTimestamp = newDate.getTime()

                  if (res.status === 200) {
                    setLastUpdateTime(newDate.getTime())

                    reportUpdate({
                      id,
                      entitySlug,
                      updatedAt: newDate.toISOString(),
                    })

                    if (!mostRecentVersionIsAutosaved) {
                      incrementVersionCount()
                      setMostRecentVersionIsAutosaved(true)
                      setUnpublishedVersionCount((prev) => prev + 1)
                    }
                  }

                  return res.json()
                })
                .then((json) => {
                  if (versionsConfig?.drafts && versionsConfig?.drafts?.validate && json?.errors) {
                    if (Array.isArray(json.errors)) {
                      const [fieldErrors, nonFieldErrors] = json.errors.reduce(
                        ([fieldErrs, nonFieldErrs], err) => {
                          const newFieldErrs = []
                          const newNonFieldErrs = []

                          if (err?.message) {
                            newNonFieldErrs.push(err)
                          }

                          if (Array.isArray(err?.data)) {
                            err.data.forEach((dataError) => {
                              if (dataError?.field) {
                                newFieldErrs.push(dataError)
                              } else {
                                newNonFieldErrs.push(dataError)
                              }
                            })
                          }

                          return [
                            [...fieldErrs, ...newFieldErrs],
                            [...nonFieldErrs, ...newNonFieldErrs],
                          ]
                        },
                        [[], []],
                      )

                      dispatchFields({
                        type: 'ADD_SERVER_ERRORS',
                        errors: fieldErrors,
                      })

                      nonFieldErrors.forEach((err) => {
                        toast.error(err.message || i18n.t('error:unknown'))
                      })

                      // Set valid to false internally so the queue doesn't process
                      isValidRef.current = false
                      setIsValid(false)
                      setSubmitted(true)

                      return
                    }
                  } else {
                    // If it's not an error then we can update the document data inside the context
                    const document = json?.doc || json?.result

                    // Manually update the data since this function doesn't fire the `submit` function from useForm
                    if (document) {
                      setIsValid(true)

                      // Reset internal state allowing the queue to process
                      isValidRef.current = true
                      updateSavedDocumentData(document)
                    }
                  }
                })
                .finally(() => {
                  // If request was faster than minimum animation time, animate the difference
                  if (endTimestamp - startTimestamp < minimumAnimationTime) {
                    autosaveTimeout = setTimeout(
                      () => {
                        setSaving(false)
                      },
                      minimumAnimationTime - (endTimestamp - startTimestamp),
                    )
                  } else {
                    setSaving(false)
                  }
                })
            }
          }
        }
      }
    }

    queueRef.current.push(autosave)
    void processQueue()

    return { abortController, autosaveTimeout }
  })

  // When debounced fields change, autosave
  useEffect(() => {
    const { abortController, autosaveTimeout } = handleAutosave()

    return () => {
      if (autosaveTimeout) {
        clearTimeout(autosaveTimeout)
      }
      if (abortController.signal) {
        try {
          abortController.abort('Autosave closed early.')
        } catch (error) {
          // swallow error
        }
      }
      setSaving(false)
    }
  }, [debouncedFields])

  return (
    <div className={baseClass}>
      {validateOnDraft && !isValid && <LeaveWithoutSaving />}
      {saving && t('general:saving')}
      {!saving && Boolean(lastUpdateTime) && (
        <React.Fragment>
          {t('version:lastSavedAgo', {
            distance: formatTimeToNow({ date: lastUpdateTime, i18n }),
          })}
        </React.Fragment>
      )}
    </div>
  )
}
