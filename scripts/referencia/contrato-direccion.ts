// Modelo de aceptación en memoria. Sus entradas representan identidades y comprobantes
// ya verificados por un adaptador. No genera transacciones ni se conecta a Stellar.
import { netAfterFees } from '../../shared/fees.ts'

function exigir(condicion: unknown, mensaje: string): asserts condicion {
  if (!condicion) throw new Error(mensaje)
}

const texto = (valor: string) => typeof valor === 'string' && valor.trim().length > 0
const huellaValida = (valor: string) => /^[0-9a-f]{64}$/.test(valor)
const fechaValida = (valor: number) => Number.isSafeInteger(valor) && valor > 0
const importeValido = (valor: number) => Number.isSafeInteger(valor) && valor >= 0
const documentosPrevios = ['contratoCertificado', 'registroProveedor', 'derechoTerreno', 'planosYPermisoMunicipal'] as const
const comisionEsquoraBps = 90

export interface RevisionPrevia {
  operacion: string
  proyecto: string
  etapa: string
  predio: string
  revisora: string
  revisadoEn: number
  documentos: Record<typeof documentosPrevios[number], string>
}

export interface Acta {
  proyecto: string
  etapa: string
  predio: string
  huella: string
  firmante: string
  criterio: string
  trabajo: string
  inicioEn: number
}
type ActaPublicada = Readonly<Acta & { presentadaEn: number }>

export class Etapa {
  #versiones = new Map<string, ActaPublicada>()
  #vigente?: ActaPublicada
  #incidencia?: string
  readonly criterioInicio: string
  readonly firmantePactado: string

  constructor(readonly proyecto: string, readonly nombre: string, readonly predio: string,
    readonly desarrollador: string, readonly revisora: string, inicio: { criterio: string; firmante: string }) {
    exigir([proyecto, nombre, predio, desarrollador, revisora, inicio.criterio, inicio.firmante].every(texto),
      'Identifica la etapa, el trabajo de inicio y sus responsables.')
    this.criterioInicio = inicio.criterio
    this.firmantePactado = inicio.firmante
  }

  get acta() { return this.#vigente }
  get enRevision() { return this.#incidencia !== undefined }

  publicarActa(actor: string, acta: Acta, ahora: number) {
    exigir(actor === this.desarrollador, 'Solo el desarrollador presenta el acta.')
    exigir(acta.proyecto === this.proyecto && acta.etapa === this.nombre && acta.predio === this.predio,
      'El acta corresponde a otro proyecto, etapa o predio.')
    exigir(huellaValida(acta.huella) && texto(acta.trabajo), 'El acta necesita una versión y el trabajo físico observado.')
    exigir(acta.criterio === this.criterioInicio && acta.firmante === this.firmantePactado,
      'El acta debe identificar el criterio y el firmante pactados.')
    exigir(fechaValida(ahora) && fechaValida(acta.inicioEn) && acta.inicioEn <= ahora &&
      (!this.#vigente || ahora >= this.#vigente.presentadaEn), 'Las fechas del acta son inconsistentes.')
    exigir(!this.#versiones.has(acta.huella), 'Esta versión ya está registrada.')
    this.#vigente = Object.freeze({ ...acta, presentadaEn: ahora })
    this.#versiones.set(acta.huella, this.#vigente)
  }

  huboActaEnPlazo(limiteInicio: number, limitePresentacion: number) {
    return Array.from(this.#versiones.values()).some(v => v.inicioEn <= limiteInicio && v.presentadaEn <= limitePresentacion)
  }

  observarActa(actor: string, version: string, motivo: string) {
    exigir(actor === this.revisora && this.#vigente?.huella === version && texto(motivo), 'La revisora debe identificar el acta y el motivo.')
    this.#incidencia = motivo
  }

  aclararIncidencia(actor: string, version: string, fundamento: string) {
    exigir(actor === this.revisora && this.enRevision && this.#vigente?.huella === version && texto(fundamento),
      'La revisora debe aclarar la incidencia sobre la versión vigente.')
    this.#incidencia = undefined
  }
}

interface Acuerdo {
  id: string
  compradora: string
  tercero: string
  cuentaPlataforma: string
  inicial: number
  limiteInicio: number
  limitePresentacion: number
}

type Movimiento = 'deposito' | 'cobro' | 'devolucion'
type Estado = 'borrador' | 'por_firmar' | 'por_depositar' | 'en_confirmacion' | 'protegida' | 'en_disputa' | 'liquidada'
export interface Comprobante {
  operacion: string
  intento: number
  tipo: Movimiento
  hash: string
  bruto: number
  alSaldoProtegido: number
  alDesarrollador: number
  aCompradora: number
  comisiones: number
}

export class Preventa {
  readonly #acuerdo: Readonly<Acuerdo>
  #estado: Estado = 'borrador'
  #terceroAcepto = false
  #aprobacion?: string
  #pendiente?: Movimiento
  #numeroIntento = 0
  #revision?: Readonly<RevisionPrevia>
  #firmaDesarrolladorEn?: number
  #firmaCompradoraEn?: number
  #motivoCaso?: string
  #decision?: string
  #comprobantes = new Map<string, Readonly<Comprobante>>()
  #saldos = { depositado: 0, protegido: 0, entregado: 0, devuelto: 0, comisiones: 0 }

  constructor(readonly etapa: Etapa, acuerdo: Acuerdo) {
    const cuentas = [etapa.desarrollador, acuerdo.compradora, acuerdo.tercero, acuerdo.cuentaPlataforma]
    exigir(cuentas.every(texto) && new Set(cuentas).size === cuentas.length, 'Las cuentas de las partes, tercero y plataforma deben ser distintas.')
    exigir(texto(acuerdo.id) && importeValido(acuerdo.inicial) && acuerdo.inicial > 0 &&
      Number.isSafeInteger(acuerdo.inicial * 10_000), 'Indica un identificador y un importe exacto en centavos.')
    exigir(fechaValida(acuerdo.limiteInicio) && fechaValida(acuerdo.limitePresentacion) &&
      acuerdo.limiteInicio <= acuerdo.limitePresentacion, 'Revisa los plazos pactados.')
    this.#acuerdo = Object.freeze({ ...acuerdo })
  }

  get id() { return this.#acuerdo.id }
  get compradora() { return this.#acuerdo.compradora }
  get estado() { return this.#estado }
  get intentoPendiente() { return this.#pendiente ? this.#numeroIntento : undefined }
  get saldos() { return { ...this.#saldos } }
  get expediente() { return { revision: this.#revision, actaAprobada: this.#aprobacion, motivoCaso: this.#motivoCaso, decision: this.#decision } }

  aceptarDesignacion(actor: string) {
    exigir(this.estado === 'borrador' && actor === this.#acuerdo.tercero, 'La designación requiere al tercero externo pactado.')
    this.#terceroAcepto = true
  }

  registrarRevision(actor: string, revision: RevisionPrevia) {
    exigir(this.estado === 'borrador' && actor === this.etapa.revisora && revision.revisora === actor, 'La revisora registra la documentación del borrador.')
    exigir(revision.operacion === this.id && revision.proyecto === this.etapa.proyecto &&
      revision.etapa === this.etapa.nombre && revision.predio === this.etapa.predio, 'La revisión corresponde a otro expediente.')
    exigir(fechaValida(revision.revisadoEn), 'Revisa la fecha del expediente.')
    exigir(documentosPrevios.every(campo => huellaValida(revision.documentos[campo])), 'Falta documentación previa revisada.')
    this.#revision = Object.freeze({ ...revision, documentos: Object.freeze({ ...revision.documentos }) })
  }

  firmarDesarrollador(actor: string, ahora: number) {
    exigir(actor === this.etapa.desarrollador && this.estado === 'borrador', 'La firma corresponde al desarrollador del borrador.')
    exigir(this.#terceroAcepto, 'Falta la aceptación de la designación del tercero.')
    exigir(this.#revision && fechaValida(ahora) && this.#revision.revisadoEn <= ahora && ahora < this.#acuerdo.limiteInicio,
      'La firma requiere una revisión previa y un plazo vigente.')
    this.#firmaDesarrolladorEn = ahora
    this.#estado = 'por_firmar'
  }

  firmarCompradora(actor: string, ahora: number) {
    exigir(this.estado === 'por_firmar' && actor === this.compradora && fechaValida(ahora) &&
      ahora >= this.#firmaDesarrolladorEn! && ahora < this.#acuerdo.limiteInicio, 'La compradora debe firmar el acuerdo revisado dentro del plazo.')
    this.#firmaCompradoraEn = ahora
    this.#estado = 'por_depositar'
  }

  pedirDeposito(actor: string, importe: number, ahora: number) {
    exigir(this.estado === 'por_depositar' && actor === this.compradora, 'El depósito requiere el acuerdo firmado por las dos partes.')
    exigir(importe === this.#acuerdo.inicial, 'El importe debe coincidir con la única inicial pactada.')
    exigir(fechaValida(ahora) && ahora >= this.#firmaCompradoraEn! && ahora < this.#acuerdo.limiteInicio, 'Terminó el plazo para depositar el anticipo.')
    exigir(!this.etapa.acta, 'Ya hay acta de inicio en esta etapa.')
    this.#preparar('deposito')
  }

  aprobarActa(actor: string, version: string, ahora: number) {
    const acta = this.etapa.acta
    exigir(this.estado === 'protegida' && actor === this.compradora, 'Solo la compradora de esta operación puede aprobar.')
    exigir(!this.etapa.enRevision, 'El acta común está en revisión.')
    exigir(acta && acta.huella === version, 'Selecciona la versión vigente del acta.')
    exigir(fechaValida(ahora) && ahora >= acta.presentadaEn && acta.inicioEn <= this.#acuerdo.limiteInicio &&
      acta.presentadaEn <= this.#acuerdo.limitePresentacion, 'El acta debe acreditar el inicio y su presentación en plazo.')
    this.#aprobacion = version
  }

  pedirCobro(actor: string) {
    exigir(actor === this.etapa.desarrollador && this.estado === 'protegida' && this.#aprobacion &&
      this.#aprobacion === this.etapa.acta?.huella && !this.etapa.enRevision, 'El cobro requiere aprobación individual vigente, libre de revisión.')
    this.#preparar('cobro')
  }

  pedirDevolucion(actor: string, ahora: number) {
    exigir(this.estado === 'protegida' && actor === this.compradora, 'La solicitud corresponde a la compradora con saldo protegido.')
    exigir(fechaValida(ahora) && ahora > this.#acuerdo.limitePresentacion, 'El plazo de presentación sigue abierto.')
    exigir(!this.etapa.huboActaEnPlazo(this.#acuerdo.limiteInicio, this.#acuerdo.limitePresentacion),
      'Existe un acta presentada en plazo. La discrepancia requiere revisión.')
    this.abrirDesacuerdo(actor, 'Solicitud de devolución por vencimiento sin inicio acreditado en plazo.')
  }

  objetarActa(actor: string, motivo: string) {
    exigir(actor === this.compradora && this.etapa.acta, 'Solo la compradora puede objetar el acta de su operación.')
    this.abrirDesacuerdo(actor, motivo)
  }

  abrirDesacuerdo(actor: string, motivo: string) {
    exigir(this.estado === 'protegida' && [this.compradora, this.etapa.desarrollador].includes(actor) && texto(motivo),
      'Una parte debe abrir el caso con saldo protegido y un motivo.')
    this.#motivoCaso = motivo
    this.#estado = 'en_disputa'
  }

  resolver(actor: string, destino: 'cobro' | 'devolucion', decision: string) {
    exigir(this.estado === 'en_disputa' && actor === this.#acuerdo.tercero, 'Solo el tercero designado puede ejecutar un caso abierto.')
    exigir(texto(decision), 'Registra la referencia de la decisión documentada.')
    if (destino === 'cobro') {
      const acta = this.etapa.acta
      exigir(acta && !this.etapa.enRevision && acta.inicioEn <= this.#acuerdo.limiteInicio &&
        acta.presentadaEn <= this.#acuerdo.limitePresentacion, 'El cobro requiere un acta vigente y en plazo también en disputa.')
    } else exigir(destino === 'devolucion', 'Indica un destino válido para la resolución.')
    this.#decision = decision
    this.#preparar(destino)
  }

  #preparar(tipo: Movimiento) {
    this.#numeroIntento++
    this.#pendiente = tipo
    this.#estado = 'en_confirmacion'
  }

  // El adaptador solo comunica un rechazo definitivo del intento. Un timeout sigue pendiente.
  registrarRechazo(intento: number) {
    exigir(this.estado === 'en_confirmacion' && intento === this.#numeroIntento, 'El rechazo debe corresponder al intento pendiente.')
    if (this.#pendiente === 'deposito') this.#estado = 'por_depositar'
    else this.#estado = this.#motivoCaso ? 'en_disputa' : 'protegida'
    this.#pendiente = undefined
  }

  confirmarEnRed(recibo: Comprobante) {
    exigir(recibo.operacion === this.id && huellaValida(recibo.hash), 'Comprueba el identificador y la transacción del expediente.')
    const anterior = this.#comprobantes.get(recibo.hash)
    if (anterior) {
      exigir((Object.keys(anterior) as (keyof Comprobante)[]).every(k => anterior[k] === recibo[k]), 'Comprobante repetido con datos incompatibles.')
      return
    }
    exigir(this.estado === 'en_confirmacion' && recibo.tipo === this.#pendiente && recibo.intento === this.#numeroIntento,
      'El comprobante debe corresponder al movimiento pendiente.')
    exigir(recibo.bruto === this.#acuerdo.inicial &&
      [recibo.alSaldoProtegido, recibo.aCompradora, recibo.alDesarrollador, recibo.comisiones].every(importeValido),
      'Revisa los importes del comprobante.')
    const deposito = recibo.tipo === 'deposito'
    const neto = deposito ? 0 : netAfterFees(recibo.bruto, comisionEsquoraBps)
    exigir(recibo.alSaldoProtegido === (deposito ? recibo.bruto : 0) &&
      recibo.aCompradora === (recibo.tipo === 'devolucion' ? neto : 0) &&
      recibo.alDesarrollador === (recibo.tipo === 'cobro' ? neto : 0) &&
      recibo.comisiones === (deposito ? 0 : recibo.bruto - neto), 'El destino o el desglose difiere de lo pactado.')
    this.#saldos = { depositado: recibo.bruto, protegido: recibo.alSaldoProtegido,
      entregado: recibo.alDesarrollador, devuelto: recibo.aCompradora, comisiones: recibo.comisiones }
    this.#comprobantes.set(recibo.hash, Object.freeze({ ...recibo }))
    this.#pendiente = undefined
    this.#estado = deposito ? 'protegida' : 'liquidada'
  }
}
