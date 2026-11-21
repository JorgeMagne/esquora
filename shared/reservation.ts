export const projectRequirements = [
  { key: 'registro_proveedor', label: 'Registro del proveedor inmobiliario' },
  { key: 'derecho_terreno', label: 'Derecho sobre el terreno o facultad de venta' },
  { key: 'planos_autorizados', label: 'Planos autorizados' },
  { key: 'permiso_construccion', label: 'Permiso municipal de construcción' },
] as const

export const startEvidence = { key: 'acta_inicio', label: 'Acta de inicio de obra firmada' }

export type ReservationRecord = {
  reviewedBy: string
  reviewedAt: string
  professional: string
  documents: { key: string; label: string; fileId: string; sha256: string }[]
}
