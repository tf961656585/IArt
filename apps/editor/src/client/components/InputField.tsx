import React from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { Control, FieldValues, Path, FieldPathValue } from 'react-hook-form';
import { useController } from 'react-hook-form';

export interface InputFieldProps<T extends FieldValues = FieldValues>
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'value' | 'defaultValue'> {
  name: Path<T>;
  value: FieldPathValue<T, Path<T>> | undefined;
  defaultValue: FieldPathValue<T, Path<T>> | undefined;
  control: Control<T> | undefined;
  label: React.ReactNode | undefined;
  description: React.ReactNode | undefined;
  validateStatus: 'error' | 'success' | 'none' | undefined;
  message: React.ReactNode | undefined;
  optional: boolean | undefined;
  wrapperClassName: string | undefined;
  autoTrim: boolean | undefined;
}

type ControlledInputFieldProps<T extends FieldValues> = Omit<InputFieldProps<T>, 'control'> & {
  control: Control<T>;
};
type UncontrolledInputFieldProps<T extends FieldValues> = Omit<InputFieldProps<T>, 'control'>;

type ControlledInputFieldComponent = <T extends FieldValues>(
  props: ControlledInputFieldProps<T> & React.RefAttributes<HTMLInputElement>
) => React.ReactElement | null;

type UncontrolledInputFieldComponent = <T extends FieldValues>(
  props: UncontrolledInputFieldProps<T> & React.RefAttributes<HTMLInputElement>
) => React.ReactElement | null;

type InputFieldComponent = <T extends FieldValues>(
  props: InputFieldProps<T> & React.RefAttributes<HTMLInputElement>
) => React.ReactElement | null;

const hasControl = <T extends FieldValues>(
  props: InputFieldProps<T>
): props is ControlledInputFieldProps<T> => Boolean(props.control);

const mergeRefs = <T,>(...refs: Array<React.Ref<T> | undefined>) =>
  (value: T | null) => {
    refs.forEach(refItem => {
      if (!refItem) return;
      if (typeof refItem === 'function') {
        refItem(value);
      } else {
        (refItem as MutableRefObject<T | null>).current = value;
      }
    });
  };

const computeStatus = (
  externalStatus: InputFieldProps['validateStatus'],
  hasError: boolean,
  isTouched: boolean
): 'error' | 'success' | 'none' => {
  if (externalStatus) return externalStatus;
  if (hasError) return 'error';
  if (isTouched && !hasError) return 'success';
  return 'none';
};

const ControlledInputFieldInner = <T extends FieldValues>(
  props: ControlledInputFieldProps<T>,
  forwardedRef: React.ForwardedRef<HTMLInputElement>
) => {
  const {
    name,
    control,
    label,
    description,
    validateStatus: externalStatus,
    message: externalMessage,
    optional,
    className,
    wrapperClassName,
    autoTrim = true,
    onChange,
    onBlur,
    ...rest
  } = props;

  const { t } = useTranslation('forms');
  const { field, fieldState } = useController({ name, control });
  const fieldError = fieldState.error;
  const status = computeStatus(externalStatus, Boolean(fieldError), fieldState.isTouched);
  const message = externalMessage ?? (fieldError !== null && fieldError !== undefined ? fieldError.message : undefined) ?? null;

  const assignRef = mergeRefs<HTMLInputElement>(field.ref, forwardedRef);

  const inputProps = { ...rest };
  const inputValue = (field.value ?? '') as string | number | readonly string[];
  const describedBy = [
    `${name}-message`,
    description ? `${name}-description` : undefined
  ]
    .filter(Boolean)
    .join(' ');

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = event => {
    if (autoTrim) {
      const trimmed = event.target.value.replace(/\s+/g, ' ').trimStart();
      event.target.value = trimmed;
    }
    field.onChange(event);
    if (onChange !== null && onChange !== undefined) {
      onChange(event);
    }
  };

  const handleBlur: React.FocusEventHandler<HTMLInputElement> = event => {
    if (autoTrim) {
      const trimmed = event.target.value.trim();
      event.target.value = trimmed;
    }
    field.onBlur();
    if (onBlur !== null && onBlur !== undefined) {
      onBlur(event);
    }
  };

  return (
    <div className={clsx('form-field', wrapperClassName)}>
      {label && (
        <label className="form-label" htmlFor={name}>
          <span>{label}</span>
          {optional && <span className="form-optional">{t('forms:field.optional')}</span>}
        </label>
      )}
      <div className="form-control">
        <input
          {...field}
          {...inputProps}
          ref={assignRef}
          id={name}
          aria-invalid={status === 'error'}
          aria-describedby={describedBy}
          className={clsx(
            'form-input',
            status === 'error' && 'is-error',
            status === 'success' && 'is-valid',
            className
          )}
          value={inputValue}
          onChange={handleChange}
          onBlur={handleBlur}
        />
      </div>
      {description && (
        <div id={`${name}-description`} className="form-description">
          {description}
        </div>
      )}
      <div
        id={`${name}-message`}
        aria-live="polite"
        className={clsx(
          'form-message',
          status === 'error' && 'error',
          status === 'success' && 'success'
        )}
      >
        {message || '\u00A0'}
      </div>
    </div>
  );
};
const ControlledInputField = React.forwardRef(ControlledInputFieldInner) as ControlledInputFieldComponent;

const UncontrolledInputFieldInner = <T extends FieldValues>(
  props: UncontrolledInputFieldProps<T>,
  ref: React.ForwardedRef<HTMLInputElement>
) => {
  const {
    name,
    label,
    description,
    validateStatus: externalStatus,
    message: externalMessage,
    optional,
    className,
    wrapperClassName,
    autoTrim = true,
    onChange,
    onBlur,
    ...rest
  } = props;

  const { t } = useTranslation('forms');
  const status = externalStatus ?? 'none';
  const message = externalMessage ?? null;
  const describedBy = [
    `${name}-message`,
    description ? `${name}-description` : undefined
  ]
    .filter(Boolean)
    .join(' ');

  const { value, defaultValue, ...inputProps } = rest;
  const inputValue = (value ?? defaultValue ?? '') as string | number | readonly string[];

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = event => {
    if (autoTrim) {
      const trimmed = event.target.value.replace(/\s+/g, ' ').trimStart();
      event.target.value = trimmed;
    }
    if (onChange !== null && onChange !== undefined) {
      onChange(event);
    }
  };

  const handleBlur: React.FocusEventHandler<HTMLInputElement> = event => {
    if (autoTrim) {
      const trimmed = event.target.value.trim();
      event.target.value = trimmed;
    }
    if (onBlur !== null && onBlur !== undefined) {
      onBlur(event);
    }
  };

  return (
    <div className={clsx('form-field', wrapperClassName)}>
      {label && (
        <label className="form-label" htmlFor={name}>
          <span>{label}</span>
          {optional && <span className="form-optional">{t('forms:field.optional')}</span>}
        </label>
      )}
      <div className="form-control">
        <input
          {...inputProps}
          ref={ref}
          id={name}
          name={name}
          aria-invalid={status === 'error'}
          aria-describedby={describedBy}
          className={clsx(
            'form-input',
            status === 'error' && 'is-error',
            status === 'success' && 'is-valid',
            className
          )}
          value={inputValue}
          onChange={handleChange}
          onBlur={handleBlur}
        />
      </div>
      {description && (
        <div id={`${name}-description`} className="form-description">
          {description}
        </div>
      )}
      <div
        id={`${name}-message`}
        aria-live="polite"
        className={clsx(
          'form-message',
          status === 'error' && 'error',
          status === 'success' && 'success'
        )}
      >
        {message || '\u00A0'}
      </div>
    </div>
  );
};
const UncontrolledInputField = React.forwardRef(UncontrolledInputFieldInner) as UncontrolledInputFieldComponent;

const InputFieldInner = <T extends FieldValues>(
  props: InputFieldProps<T>,
  ref: React.ForwardedRef<HTMLInputElement>
) => {
  if (hasControl(props)) {
    return <ControlledInputField {...props} ref={ref} />;
  }
  return <UncontrolledInputField {...props} ref={ref} />;
};
const InputField = React.forwardRef(InputFieldInner) as InputFieldComponent;

export { InputField };
export default InputField;





