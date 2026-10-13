import 'react-i18next';
import type { defaultNS, ResourceSchema } from '../i18n/resources';

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: ResourceSchema;
  }
}
