// @ts-nocheck eslint-disable-next-line
import type {
  ClientCollectionConfig,
  ClientConfig,
  ClientField,
  ClientGlobalConfig,
  RenderConfigArgs,
} from 'payload'

import { type I18nClient, initI18n } from '@payloadcms/translations'
import { getCreateMappedComponent } from '@payloadcms/ui/shared'
import { createClientCollectionConfig } from '@payloadcms/ui/utilities/createClientCollectionConfig'
import { createClientConfig } from '@payloadcms/ui/utilities/createClientConfig'
import { createClientFields } from '@payloadcms/ui/utilities/createClientFields'
import { createClientGlobalConfig } from '@payloadcms/ui/utilities/createClientGlobalConfig'

import { getPayloadHMR } from './getPayloadHMR.js'

export const renderConfig = async (
  args: RenderConfigArgs,
): Promise<ClientCollectionConfig | ClientConfig | ClientField[] | ClientGlobalConfig> => {
  const {
    collectionSlug,
    config: configPromise,
    formState,
    globalSlug,
    importMap,
    languageCode,
    schemaPath,
    serverProps,
  } = args

  if (!languageCode) {
    throw new Error('Language code is required to render config')
  }

  const config = await configPromise

  const i18n: I18nClient = await initI18n({
    config: config.i18n,
    context: 'client',
    language: languageCode,
  })

  const payload = await getPayloadHMR({ config })

  const createMappedComponent = getCreateMappedComponent({
    importMap,
    serverProps: {
      ...(serverProps || {}),
      payload,
    },
  })

  if (schemaPath) {
    const renderedSchemaPath = createClientFields({
      createMappedComponent,
      formState,
      importMap,
      payload,
    })

    return renderedSchemaPath
  }

  if (collectionSlug) {
    const renderedCollectionConfig = createClientCollectionConfig({
      collection: config.collections.find((collection) => collection.slug === collectionSlug),
      createMappedComponent,
      formState,
      i18n,
      importMap,
      payload,
    })

    return renderedCollectionConfig
  }

  if (globalSlug) {
    const renderedGlobalConfig = createClientGlobalConfig({
      createMappedComponent,
      formState,
      global: config.globals.find((global) => global.slug === globalSlug),
      i18n,
      importMap,
      payload,
    })

    return renderedGlobalConfig
  }

  const renderedRootConfig = await createClientConfig({
    config,
    createMappedComponent,
    i18n,
    importMap,
    payload,
  })

  return renderedRootConfig
}