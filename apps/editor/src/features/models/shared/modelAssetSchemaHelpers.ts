import type {
  SchemaBuildContext,
  SchemaFormValues,
  SchemaPromptConfig,
} from '@/features/workspace/schema/types';
import type { PromptUpdateCommand } from '@/features/workspace/modelFormTypes';

type RuntimeUploadOptions = {
  url_input_upload_mode: unknown | undefined;
  url_input_upload_target_type: unknown | undefined;
};

const applyPromptCommand = (
  values: SchemaFormValues<string>,
  promptFieldKey: string,
  command: PromptUpdateCommand,
): SchemaFormValues<string> => {
  const current = values[promptFieldKey];
  const currentText = typeof current === 'string' ? current : '';
  const nextText =
    command.mode === 'append' && currentText
      ? `${currentText}\n${command.text}`
      : command.text;
  return {
    ...values,
    [promptFieldKey]: nextText,
  };
};

export const buildSchemaPromptConfig = (
  promptFieldKey: string | undefined,
): SchemaPromptConfig<string> | undefined => {
  if (promptFieldKey === undefined) {
    return undefined;
  }
  return {
    primaryField: promptFieldKey,
    summaryField: undefined,
    derivePrompt: (values) => {
      const rawPrompt = values[promptFieldKey];
      return typeof rawPrompt === 'string' ? rawPrompt : undefined;
    },
    applyCommand: (values, command) =>
      applyPromptCommand(values, promptFieldKey, command),
  };
};

export const applyRuntimeUploadOptions = (
  context: SchemaBuildContext<string>,
  runtimeOptions: RuntimeUploadOptions,
): void => {
  context.runtime = {
    ...(context.runtime ?? {}),
    ...runtimeOptions,
  };
};
