import { Field as BaseField } from '@base-ui/react/field';
import { tv } from 'tailwind-variants';
import { Label, type LabelProps } from '@/components/panelui/label';

const fieldVariants = tv({
  slots: {
    root: 'group/field flex w-full min-w-0 flex-col gap-2',
    description: [
      'text-xs leading-4 text-muted-foreground',
      // An error showing says more than the help line, so the help steps aside.
      'group-has-[[data-slot=field-error]]/field:hidden',
    ],
    error: [
      'text-xs leading-4 text-destructive',
      'transition-[opacity,translate] duration-200 starting:-translate-y-1 starting:opacity-0 motion-reduce:transition-none',
    ],
  },
});

export interface FieldProps extends Omit<BaseField.Root.Props, 'className'> {
  className?: string;
}

/**
 * Groups a control with its label, help and error. Takes `name`, `invalid`
 * (for an error from outside, such as a server), `disabled`, and `validate`
 * for a check of your own.
 */
function FieldRoot({ className, ...props }: FieldProps) {
  return <BaseField.Root data-slot="field" className={fieldVariants().root({ className })} {...props} />;
}
FieldRoot.displayName = 'Field';

export interface FieldLabelProps extends Omit<LabelProps, 'invalid' | 'disabled' | 'htmlFor'> {}

/** The control's name, tied to it. Takes `required` and `optional` as Label does, and its parts. */
function FieldLabel({ required, optional, className, children, ...props }: FieldLabelProps) {
  return (
    <BaseField.Label
      data-slot="field-label"
      className={className}
      render={(labelProps) => <Label {...labelProps} required={required} optional={optional} />}
      {...(props as Omit<BaseField.Label.Props, 'className' | 'render'>)}
    >
      {children}
    </BaseField.Label>
  );
}
FieldLabel.displayName = 'Field.Label';

export interface FieldDescriptionProps extends Omit<BaseField.Description.Props, 'className'> {
  className?: string;
}

/** A line of help under the control. Hidden while an error is showing. */
function FieldDescription({ className, ...props }: FieldDescriptionProps) {
  return (
    <BaseField.Description
      data-slot="field-description"
      className={fieldVariants().description({ className })}
      {...props}
    />
  );
}
FieldDescription.displayName = 'Field.Description';

export interface FieldErrorProps extends Omit<BaseField.Error.Props, 'className'> {
  className?: string;
}

/**
 * Why the value was refused. `match` names the check it is for, such as
 * `valueMissing` or `typeMismatch`; with none, it shows whenever the field is
 * invalid. With no children it shows the browser's own message.
 */
function FieldError({ className, ...props }: FieldErrorProps) {
  return <BaseField.Error data-slot="field-error" className={fieldVariants().error({ className })} {...props} />;
}
FieldError.displayName = 'Field.Error';

export const Field = Object.assign(FieldRoot, {
  Label: FieldLabel,
  Description: FieldDescription,
  Error: FieldError,
});

export { FieldLabel, FieldDescription, FieldError };
