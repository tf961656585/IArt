import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@iart/ui';
import { FieldLabelRow } from './InfoHint';
import { PROVIDER_FIELD_HINTS } from './ProviderFormDialog';

export function CredentialDialog({
  providerName,
  hasCredential,
  onClose,
  onSubmit,
}: {
  providerName: string;
  hasCredential: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle>{hasCredential ? `更换「${providerName}」的密钥` : `插入「${providerName}」的密钥`}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <FieldLabelRow
            htmlFor="provider-credential-input"
            label="密钥"
            hint={PROVIDER_FIELD_HINTS.credential}
          />
          <Input
            id="provider-credential-input"
            type="password"
            value={value}
            placeholder="粘贴服务商给的密钥"
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button
            type="button"
            disabled={busy || value.trim() === ''}
            onClick={() => {
              setBusy(true);
              void onSubmit(value.trim()).finally(() => setBusy(false));
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
