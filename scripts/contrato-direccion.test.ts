import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Etapa, Preventa, type Acta, type RevisionPrevia, type Comprobante } from './referencia/contrato-direccion.ts'

// Minutos relativos a las 08:00 de una jornada ficticia. La máquina usa milisegundos.
const aLas = (minutos: number) => Date.UTC(2026, 10, 20, 12, minutos)
const huella = (digito: string) => digito.repeat(64)
const inicial = 1_000_000 // 10.000,00 en centavos

function etapa(proyecto: string) {
  return new Etapa(proyecto, 'Torre 1', 'Predio ' + proyecto, 'Constructora', 'Revisora', {
    criterio: 'Comienzo de excavación de cimentación del eje A', firmante: 'Ing. Vega',
  })
}

function operacion(e: Etapa, compradora = 'Ana', tercero = 'Centro externo') {
  return new Preventa(e, {
    id: e.proyecto + '/' + compradora, compradora, tercero, cuentaPlataforma: 'ESQUORA',
    inicial, limiteInicio: aLas(60), limitePresentacion: aLas(90),
  })
}

function previa(op: Preventa): RevisionPrevia {
  return {
    operacion: op.id, proyecto: op.etapa.proyecto, etapa: op.etapa.nombre, predio: op.etapa.predio,
    revisora: 'Revisora', revisadoEn: aLas(0),
    documentos: { contratoCertificado: huella('a'), registroProveedor: huella('b'),
      derechoTerreno: huella('c'), planosYPermisoMunicipal: huella('d') },
  }
}

function acta(e: Etapa, cambios: Partial<Acta> = {}): Acta {
  return {
    proyecto: e.proyecto, etapa: e.nombre, predio: e.predio, huella: huella('e'), firmante: 'Ing. Vega',
    criterio: e.criterioInicio, trabajo: 'Excavación de cimentación en el eje A de la Torre 1', inicioEn: aLas(45), ...cambios,
  }
}

function firmada(op: Preventa) {
  op.aceptarDesignacion('Centro externo')
  op.registrarRevision('Revisora', previa(op))
  op.firmarDesarrollador('Constructora', aLas(1))
  op.firmarCompradora(op.compradora, aLas(2))
}

function recibo(op: Preventa, tipo: Comprobante['tipo'], digito: string): Comprobante {
  return {
    operacion: op.id, intento: op.intentoPendiente!, tipo, hash: createHash('sha256').update(op.id + '/' + digito).digest('hex'), bruto: inicial,
    alSaldoProtegido: tipo === 'deposito' ? inicial : 0,
    alDesarrollador: tipo === 'cobro' ? 988_000 : 0, aCompradora: tipo === 'devolucion' ? 988_000 : 0,
    comisiones: tipo === 'deposito' ? 0 : 12_000,
  }
}

function fondeada(op: Preventa) {
  firmada(op)
  op.pedirDeposito(op.compradora, inicial, aLas(3))
  op.confirmarEnRed(recibo(op, 'deposito', '1'))
}

test('A. Un expediente revisado, un depósito, aprobación propia y un cobro neto confirmado', t => {
  const e = etapa('Jacarandá')
  const op = operacion(e)
  fondeada(op)
  assert.throws(() => op.pedirCobro('Constructora'), /aprobación/)
  e.publicarActa('Constructora', acta(e), aLas(55))
  assert.throws(() => op.pedirCobro('Constructora'), /aprobación/)
  op.aprobarActa('Ana', huella('e'), aLas(56))
  op.pedirCobro('Constructora')
  assert.equal(op.saldos.protegido, inicial)
  const pago = recibo(op, 'cobro', '2')
  op.confirmarEnRed(pago)
  op.confirmarEnRed(pago)
  assert.deepEqual(op.saldos, { depositado: inicial, protegido: 0, entregado: 988_000, devuelto: 0, comisiones: 12_000 })
  assert.equal(op.estado, 'liquidada')
  t.diagnostic('Proyecto Jacarandá · 10.000 depositados · 9.880 al desarrollador · 120 en comisiones · 0 protegidos.')
})

test('B. Vencimiento sin acta, solicitud individual y devolución ejecutada por el tercero', t => {
  const op = operacion(etapa('Tajibo'), 'Beatriz')
  fondeada(op)
  assert.throws(() => op.pedirDevolucion('Beatriz', aLas(90)), /plazo/)
  op.pedirDevolucion('Beatriz', aLas(91))
  assert.throws(() => op.resolver('ESQUORA', 'devolucion', 'Decisión B-1'), /tercero/)
  assert.throws(() => op.resolver('Centro externo', 'devolucion', ''), /decisión/)
  op.resolver('Centro externo', 'devolucion', 'Decisión B-1 por vencimiento acreditado')
  assert.equal(op.saldos.protegido, inicial)
  op.confirmarEnRed(recibo(op, 'devolucion', '3'))
  assert.deepEqual(op.saldos, { depositado: inicial, protegido: 0, entregado: 0, devuelto: 988_000, comisiones: 12_000 })
  t.diagnostic('Proyecto Tajibo · 10.000 depositados · 9.880 a la compradora · 120 en comisiones · 0 protegidos.')
})

test('el expediente incompleto, ajeno o sin revisión y el tercero sin aceptar bloquean la firma y el depósito', () => {
  const op = operacion(etapa('A'))
  const revision = previa(op)
  assert.throws(() => op.firmarDesarrollador('Constructora', aLas(1)), /designación/)
  op.aceptarDesignacion('Centro externo')
  assert.throws(() => op.registrarRevision('Constructora', revision), /revisora/)
  assert.throws(() => op.firmarDesarrollador('Constructora', aLas(1)), /revisión/)
  for (const campo of Object.keys(revision.documentos) as (keyof typeof revision.documentos)[]) {
    const documentos = { ...revision.documentos, [campo]: '' }
    assert.throws(() => op.registrarRevision('Revisora', { ...revision, documentos }), /documentación/)
  }
  for (const cambio of [{ operacion: 'otra' }, { predio: 'otro' }, { revisora: '' }, { revisadoEn: NaN }]) {
    assert.throws(() => op.registrarRevision('Revisora', { ...revision, ...cambio }))
  }
  op.registrarRevision('Revisora', { ...revision, revisadoEn: aLas(2) })
  assert.throws(() => op.firmarDesarrollador('Constructora', aLas(1)))
  assert.throws(() => op.firmarCompradora('Ana', aLas(2)))
  assert.throws(() => op.pedirDeposito('Ana', inicial, aLas(3)))
  assert.equal(op.saldos.protegido, 0)
  assert.throws(() => operacion(op.etapa, 'Ana', 'ESQUORA'), /distintas/)
})

test('solo se admite el depósito único pactado antes del vencimiento y del inicio conocido', () => {
  const e = etapa('A')
  const op = operacion(e)
  firmada(op)
  assert.throws(() => op.pedirDeposito('Ana', 500_000, aLas(10)), /importe/)
  assert.throws(() => op.pedirDeposito('Ana', inicial, aLas(61)), /plazo/)
  e.publicarActa('Constructora', acta(e), aLas(50))
  assert.throws(() => op.pedirDeposito('Ana', inicial, aLas(51)), /acta/)
})

test('39 aprobaciones sobre la misma versión dejan el dinero del comprador que objeta en su propio caso', () => {
  const e = etapa('C')
  const operaciones = Array.from({ length: 40 }, (_, i) => operacion(e, 'Comprador ' + i))
  for (const op of operaciones) fondeada(op)
  e.publicarActa('Constructora', acta(e), aLas(55))
  for (const op of operaciones.slice(0, 39)) op.aprobarActa(op.compradora, huella('e'), aLas(56))
  const ultima = operaciones[39]
  assert.throws(() => ultima.aprobarActa('Comprador 0', huella('e'), aLas(56)))
  ultima.objetarActa(ultima.compradora, 'Mi acuerdo identifica otra unidad.')
  assert.throws(() => ultima.pedirCobro('Constructora'))
  assert.equal(ultima.saldos.protegido, inicial)
  operaciones[0].pedirCobro('Constructora')
  ultima.resolver('Centro externo', 'devolucion', 'Decisión individual C-40')
})

test('una incidencia común pausa cobros pendientes y una versión corregida exige nueva aprobación', () => {
  const e = etapa('C')
  const op = operacion(e)
  fondeada(op)
  const primera = acta(e)
  e.publicarActa('Constructora', primera, aLas(55))
  op.aprobarActa('Ana', primera.huella, aLas(56))
  assert.throws(() => e.observarActa('Ana', primera.huella, 'Duda'), /revisora/)
  e.observarActa('Revisora', primera.huella, 'El plano anexo parece de otra torre.')
  assert.throws(() => op.pedirCobro('Constructora'))
  e.publicarActa('Constructora', acta(e, { huella: huella('f') }), aLas(57))
  assert.throws(() => op.aprobarActa('Ana', huella('f'), aLas(58)), /revisión/)
  e.aclararIncidencia('Revisora', huella('f'), 'Predio contrastado con el plano correcto.')
  assert.throws(() => op.pedirCobro('Constructora'), /aprobación/)
  op.aprobarActa('Ana', huella('f'), aLas(59))
  op.pedirCobro('Constructora')
})

test('la fecha física y la de presentación tienen límites distintos y un acta ajena no acredita el inicio', () => {
  const e = etapa('A')
  const op = operacion(e)
  fondeada(op)
  assert.throws(() => e.publicarActa('Constructora', acta(e, { predio: 'B' }), aLas(80)))
  assert.throws(() => e.publicarActa('Constructora', acta(e, { firmante: '' }), aLas(80)))
  assert.throws(() => e.publicarActa('Constructora', acta(e, { firmante: 'Agente de ventas' }), aLas(80)), /pactado/)
  assert.throws(() => e.publicarActa('Constructora', acta(e, { criterio: 'Colocación de un cartel' }), aLas(80)), /pactado/)
  e.publicarActa('Constructora', acta(e, { inicioEn: aLas(60) }), aLas(90))
  assert.throws(() => op.pedirDevolucion('Ana', aLas(91)), /acta/)
  op.aprobarActa('Ana', huella('e'), aLas(91))
  for (const [inicio, entrega] of [[61, 80], [60, 91]]) {
    const otra = operacion(etapa('B'))
    fondeada(otra)
    otra.etapa.publicarActa('Constructora', acta(otra.etapa, { inicioEn: aLas(inicio) }), aLas(entrega))
    assert.throws(() => otra.aprobarActa('Ana', huella('e'), aLas(92)), /plazo/)
    otra.pedirDevolucion('Ana', aLas(92))
  }
})

test('una controversia por falta de conformidad conserva el saldo hasta una decisión documentada', () => {
  const e = etapa('B')
  const op = operacion(e)
  fondeada(op)
  e.publicarActa('Constructora', acta(e), aLas(50))
  op.abrirDesacuerdo('Constructora', 'Acta presentada, solicito revisión de la falta de conformidad.')
  assert.throws(() => op.pedirCobro('Constructora'))
  op.resolver('Centro externo', 'cobro', 'Resolución externa B-3')
  op.confirmarEnRed(recibo(op, 'cobro', '4'))
  assert.equal(op.saldos.entregado, 988_000)
})

test('abrir una disputa no permite cobrar una inicial sin acta de inicio acreditada en plazo', () => {
  const op = operacion(etapa('A'))
  fondeada(op)
  op.abrirDesacuerdo('Constructora', 'Solicito el cobro.')
  assert.throws(() => op.resolver('Centro externo', 'cobro', 'Resolución sin acta'), /acta/)
  assert.equal(op.saldos.protegido, inicial)
})

test('un rechazo definitivo conserva el saldo y reintentar exige que la operación siga autorizada', () => {
  const e = etapa('A')
  const op = operacion(e)
  firmada(op)
  op.pedirDeposito('Ana', inicial, aLas(10))
  const intentoFallido = op.intentoPendiente!
  op.registrarRechazo(intentoFallido)
  op.pedirDeposito('Ana', inicial, aLas(12))
  assert.throws(() => op.registrarRechazo(intentoFallido))
  op.confirmarEnRed(recibo(op, 'deposito', '1'))
  e.publicarActa('Constructora', acta(e), aLas(50))
  op.aprobarActa('Ana', huella('e'), aLas(51))
  op.pedirCobro('Constructora')
  e.observarActa('Revisora', huella('e'), 'El predio requiere revisión.')
  op.registrarRechazo(op.intentoPendiente!)
  assert.throws(() => op.pedirCobro('Constructora'))
  assert.equal(op.saldos.protegido, inicial)
})

test('los comprobantes se aplican a la operación, al destino y una sola vez', () => {
  const op = operacion(etapa('A'))
  firmada(op)
  op.pedirDeposito('Ana', inicial, aLas(3))
  const deposito = recibo(op, 'deposito', '1')
  assert.throws(() => op.confirmarEnRed({ ...deposito, operacion: 'otra' }))
  assert.throws(() => op.confirmarEnRed({ ...deposito, bruto: 0 }))
  assert.equal(op.saldos.protegido, 0)
  op.confirmarEnRed(deposito)
  assert.throws(() => op.pedirDeposito('Ana', inicial, aLas(4)))
  op.pedirDevolucion('Ana', aLas(91))
  op.resolver('Centro externo', 'devolucion', 'Decisión individual')
  const devolucion = recibo(op, 'devolucion', '2')
  for (const cambio of [{ tipo: 'cobro' as const }, { aCompradora: 1_000_000 }, { comisiones: -1 },
    { alDesarrollador: 988_000, aCompradora: 0 }, { hash: deposito.hash }]) {
    assert.throws(() => op.confirmarEnRed({ ...devolucion, ...cambio }))
  }
  op.confirmarEnRed(devolucion)
  op.confirmarEnRed(devolucion)
  assert.equal(op.saldos.devuelto, 988_000)
  assert.throws(() => op.confirmarEnRed({ ...devolucion, hash: huella('3') }))
})
