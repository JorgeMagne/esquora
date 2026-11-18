import type { ResolutionMode } from './api.ts'
import { Field } from './ui.tsx'
import './preventa.css'

const choices = {
  pending: 'Decidir más adelante',
  external: 'Invitar a un tercero',
  esquora: 'ESQUORA verifica y ejecuta',
} satisfies Record<ResolutionMode, string>

const help = {
  pending: 'Guarda el borrador y confirma la modalidad antes de enviar el acuerdo.',
  external: 'El tercero deberá aceptar la invitación con este correo antes de enviar el acuerdo al comprador.',
  esquora: 'Ambas partes deberán aceptar por separado las condiciones de verificación y ejecución de ESQUORA.',
} satisfies Record<ResolutionMode, string>

export function ResolverOptions({ mode, email, onMode, onEmail }: {
  mode: ResolutionMode
  email: string
  onMode: (mode: ResolutionMode) => void
  onEmail: (email: string) => void
}) {
  return <div className="stack">
    <Field label="¿Cómo se tramitará una devolución o un desacuerdo?" help={help[mode]}>
      <select name="resolutionMode" value={mode} onChange={(event) => onMode(event.target.value as ResolutionMode)}>
        {Object.entries(choices).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </Field>
    {mode === 'external' && <Field label="Correo del tercero designado">
      <input name="arbiterEmail" type="email" autoComplete="off" maxLength={200} value={email}
        onChange={(event) => onEmail(event.target.value)} required />
    </Field>}
  </div>
}
