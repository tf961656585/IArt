import type { PromptUpdateCommand } from "@/features/workspace/modelFormTypes";

export interface PromptCarrier {
  prompt: string | undefined;
}

const normalizePrompt = (value: string | undefined): string => (typeof value === "string" ? value : "");

export const buildPromptFromCommand = (current: string | undefined, command: PromptUpdateCommand): string => {
  const base = normalizePrompt(current);
  if (command.mode === "append" && base.trim()) {
    return `${base.trim()}\n\n${command.text}`;
  }
  return command.text;
};

export const getPromptValue = <T extends PromptCarrier>(values: T): string => normalizePrompt(values.prompt);

export const applyPromptCommand = <T extends PromptCarrier>(values: T, command: PromptUpdateCommand): T => {
  const nextPrompt = buildPromptFromCommand(values.prompt, command);
  return {
    ...values,
    prompt: nextPrompt,
  } as T;
};

export const createPromptHandlers = <T extends PromptCarrier>() => ({
  getPrompt: (values: T): string => getPromptValue(values),
  applyPrompt: (values: T, command: PromptUpdateCommand): T => applyPromptCommand(values, command),
});

