import type { PathToQuery } from './queryValidation/types.js'

import {
  type Field,
  fieldShouldBeLocalized,
  type FlattenedBlock,
  type FlattenedField,
} from '../fields/config/types.js'
import { APIError, type Payload, type SanitizedCollectionConfig } from '../index.js'

export function getLocalizedPaths({
  collectionSlug,
  fields,
  globalSlug,
  incomingPath,
  locale,
  overrideAccess = false,
  parentIsLocalized,
  payload,
}: {
  collectionSlug?: string
  fields: FlattenedField[]
  globalSlug?: string
  incomingPath: string
  locale?: string
  overrideAccess?: boolean
  /**
   * @todo make required in v4.0. Usually, you'd wanna pass this through
   */
  parentIsLocalized?: boolean
  payload: Payload
}): PathToQuery[] {
  const pathSegments = incomingPath.split('.')
  const localizationConfig = payload.config.localization

  let paths: PathToQuery[] = [
    {
      collectionSlug,
      complete: false,
      // @ts-expect-error - vestiges of when tsconfig was not strict. Feel free to improve
      field: undefined,
      fields,
      globalSlug,
      invalid: false,
      parentIsLocalized: parentIsLocalized!,
      path: '',
    },
  ]

  for (let i = 0; i < pathSegments.length; i += 1) {
    const segment = pathSegments[i]

    const lastIncompletePath = paths.find(({ complete }) => !complete)

    if (lastIncompletePath) {
      const { path } = lastIncompletePath
      let currentPath = path ? `${path}.${segment}` : segment

      let fieldsToSearch: FlattenedField[]
      let _parentIsLocalized = parentIsLocalized

      let matchedField!: FlattenedField

      if (lastIncompletePath?.field?.type === 'blocks') {
        if (segment === 'blockType') {
          matchedField = {
            name: 'blockType',
            type: 'text',
          }
        } else {
          for (const _block of lastIncompletePath.field.blockReferences ??
            lastIncompletePath.field.blocks) {
            let block: FlattenedBlock
            if (typeof _block === 'string') {
              block = payload.blocks[_block]!
            } else {
              block = _block
            }

            matchedField = block.flattenedFields.find((field) => field.name === segment)!
            if (matchedField) {
              break
            }
          }
        }
      } else {
        if (lastIncompletePath?.field && 'flattenedFields' in lastIncompletePath.field) {
          fieldsToSearch = lastIncompletePath.field.flattenedFields
        } else {
          fieldsToSearch = lastIncompletePath.fields!
        }
        _parentIsLocalized = parentIsLocalized || lastIncompletePath.field?.localized

        matchedField = fieldsToSearch.find((field) => field.name === segment)!
      }

      lastIncompletePath.field = matchedField!

      if (currentPath === 'globalType' && globalSlug) {
        lastIncompletePath.path = currentPath
        lastIncompletePath.complete = true
        lastIncompletePath.field = {
          name: 'globalType',
          type: 'text',
        }

        return paths
      }

      if (currentPath === 'relationTo') {
        lastIncompletePath.path = currentPath
        lastIncompletePath.complete = true
        lastIncompletePath.field = {
          name: 'relationTo',
          type: 'select',
          options: Object.keys(payload.collections),
        }

        return paths
      }

      if (!matchedField && currentPath === 'id' && i === pathSegments.length - 1) {
        lastIncompletePath.path = currentPath
        const idField: Field = {
          name: 'id',
          type: payload.db.defaultIDType as 'text',
        }
        lastIncompletePath.field = idField
        lastIncompletePath.complete = true
        return paths
      }

      if (matchedField) {
        if ('hidden' in matchedField && matchedField.hidden && !overrideAccess) {
          lastIncompletePath.invalid = true
        }

        const nextSegment = pathSegments[i + 1]!
        const nextSegmentIsLocale =
          localizationConfig && localizationConfig.localeCodes.includes(nextSegment)

        if (nextSegmentIsLocale) {
          // Skip the next iteration, because it's a locale
          i += 1
          currentPath = `${currentPath}.${nextSegment}`
        } else if (
          localizationConfig &&
          fieldShouldBeLocalized({ field: matchedField, parentIsLocalized: _parentIsLocalized! })
        ) {
          currentPath = `${currentPath}.${locale}`
        }

        switch (matchedField.type) {
          case 'join':
          case 'relationship':
          case 'upload': {
            // If this is a polymorphic relation,
            // We only support querying directly (no nested querying)
            if (matchedField.type !== 'join' && typeof matchedField.relationTo !== 'string') {
              lastIncompletePath.path = pathSegments.join('.')
              if (![matchedField.name, 'relationTo', 'value'].includes(pathSegments.at(-1)!)) {
                lastIncompletePath.invalid = true
              } else {
                lastIncompletePath.complete = true
              }
            } else {
              lastIncompletePath.complete = true
              lastIncompletePath.path = currentPath!

              const nestedPathToQuery = pathSegments
                .slice(nextSegmentIsLocale ? i + 2 : i + 1)
                .join('.')

              if (nestedPathToQuery) {
                let relatedCollection: SanitizedCollectionConfig
                if (matchedField.type === 'join') {
                  if (Array.isArray(matchedField.collection)) {
                    throw new APIError('Not supported')
                  }

                  relatedCollection = payload.collections[matchedField.collection]!.config
                } else {
                  relatedCollection = payload.collections[matchedField.relationTo as string]!.config
                }

                const remainingPaths = getLocalizedPaths({
                  collectionSlug: relatedCollection.slug,
                  fields: relatedCollection.flattenedFields,
                  globalSlug,
                  incomingPath: nestedPathToQuery,
                  locale,
                  parentIsLocalized: false,
                  payload,
                })

                paths = [...paths, ...remainingPaths]
              }

              return paths
            }

            break
          }
          case 'json':
          case 'richText': {
            const upcomingSegments = pathSegments.slice(i + 1).join('.')
            lastIncompletePath.complete = true
            lastIncompletePath.path = upcomingSegments
              ? `${currentPath}.${upcomingSegments}`
              : currentPath!
            return paths
          }

          default: {
            if (i + 1 === pathSegments.length) {
              lastIncompletePath.complete = true
            }
            lastIncompletePath.path = currentPath!
          }
        }
      } else {
        lastIncompletePath.invalid = true
        lastIncompletePath.path = currentPath!
        return paths
      }
    }
  }

  return paths
}
