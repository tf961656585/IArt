"use client";

import type { FileUIPart } from "ai";
import type { FormEvent, HTMLAttributes, PropsWithChildren, RefObject } from "react";

export type AttachmentsContext = {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
};

export type TextInputContext = {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
};

export type PromptInputControllerProps = {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  __registerFileInput: (
    ref: RefObject<HTMLInputElement | null>,
    open: () => void,
  ) => void;
};

export type PromptInputProviderProps = PropsWithChildren<{
  initialInput: string | undefined;
}>;

export type PromptInputMessage = {
  text: string;
  files: FileUIPart[];
};

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit" | "onError"
> & {
  accept: string | undefined;
  multiple: boolean | undefined;
  globalDrop: boolean | undefined;
  syncHiddenInput: boolean | undefined;
  maxFiles: number | undefined;
  maxFileSize: number | undefined;
  onError: (err: {
    code: "max_files" | "max_file_size" | "accept";
    message: string;
  }) => void | undefined;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};
