# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React 19, Vite y Tailwind 4, ya elegidos en PLAN.md. Web pensada primero para celular; también se usa en computadora. Confirmado por el equipo el 17 de noviembre de 2026.

## Users

**Usuario principal: el comprador.** Una persona que compra un departamento o casa en preventa en Santa Cruz, Bolivia. Usa su celular. No tiene conocimientos técnicos ni sabe qué es una blockchain. Va a entregar una cuota inicial grande (en los casos denunciados, entre USD 20.000 y 25.000 por departamentos de unos USD 60.000) antes de que exista la obra, y teme perderla. Llega por un enlace de invitación que le envía el desarrollador. Su trabajo: entender qué se le propone, depositar, revisar lo que presenta el desarrollador, confirmar u objetar, y pedir su dinero de vuelta si no se cumple.

**Desarrollador o inmobiliaria.** Es el cliente que paga. Crea la operación, sube el contrato y los documentos, y cobra cada tramo cuando el comprador lo confirma.

**Tercero designado.** Un árbitro o centro de arbitraje elegido por las partes en el contrato. Solo interviene cuando hay un desacuerdo o una devolución sin respuesta.

**Jurado de la hackathon.** Evalúa el producto en una demostración. No es usuario, pero necesita poder verificar en la red lo que la interfaz afirma.

## Product Purpose

Asegurar el momento en que el dinero cambia de manos en una compra inmobiliaria. El dinero queda retenido en un escrow sobre Stellar, a la vista de las dos partes, y se libera por tramos cuando se cumple lo acordado, o vuelve al comprador.

Primer producto: la cuota inicial asegurada en preventas, liberada en dos tramos.

Éxito para el comprador: sabe en todo momento cuánto de su dinero sigue protegido, cuánto se entregó y cuánto volvió, y puede actuar sin recibir explicaciones técnicas.

## Positioning

Nadie puede mover el dinero por su cuenta: ni el comprador, ni el desarrollador, ni la plataforma, que no tiene firma sobre los fondos. Las reglas las hace cumplir la red, y cualquiera puede comprobarlo en un registro público. Una plataforma con base de datos propia no puede afirmar eso.

La única excepción es explícita y está en el contrato: si una parte abre un desacuerdo o piden una devolución, decide el tercero designado que ambos eligieron, y solo sobre ese tramo. Una devolución acordada la ejecuta el tercero a pedido de las dos partes. Decidido el 17 de noviembre de 2026, tras comprobar que Pollar no firma una cuenta compartida (PLAN.md, 3.1).

## Operating Context

- Documentos reales de una preventa boliviana: contrato certificado por Defensa del Consumidor (DS 4732), registro del proveedor inmobiliario (DS 5690), derecho sobre el terreno y permiso municipal de construcción.
- Dos condiciones: documentación del proyecto e inicio de obra. Cada una con importe, documentos exigidos, fecha límite y estado.
- Los inmuebles se valúan en dólares. El comprador paga en bolivianos desde su banco y ve la cotización antes de pagar.
- Cada movimiento tiene un comprobante que se puede abrir en el registro público.
- El comprador y el desarrollador miran la misma operación al mismo tiempo, cada uno en su pantalla.

## Capabilities and Constraints

- La especificación funcional completa está en PLAN.md, sección 5.
- Vocabulario obligatorio: "dinero protegido", "condición", "confirmar", "recibir pago aprobado", "pedir devolución", "desacuerdo", "tercero designado", "comprobante". Nunca "escrow", "milestone", "wallet", "firma multifirma" ni direcciones en el recorrido normal.
- Siempre se distinguen tres importes: protegido, entregado al desarrollador y devuelto.
- Nada se muestra como hecho hasta estar confirmado en la red. Mientras tanto se lee "Confirmando".
- Los datos técnicos (contrato en la red, roles, activo de prueba, prueba de protección) viven en una vista de verificación separada.
- La red es Stellar Testnet. El banco y el proveedor financiero están simulados en una pasarela aparte, rotulada como entorno de pruebas.
- Pollar muestra su propia ventana de confirmación, en inglés, en cada firma de transacción y al habilitar el activo (comprobado en la fase 0). La firma de la huella del acuerdo no la muestra. Si se puede adaptar está por probar; mientras tanto, la pantalla previa explica en español qué se va a confirmar.
- La plataforma no reemplaza al contrato, a la notaría ni a Derechos Reales, y no garantiza que la obra termine.
- Sin decidir: fecha de entrega, evidencia exacta del tramo 2, tratamiento de comisiones en devoluciones.
- Para después, si da el tiempo: que comprador y desarrollador ejecuten solos una devolución acordada, sin el tercero (PLAN.md, 3.1 y P2).

## Brand Commitments

El nombre del producto es **ESQUORA**, fijado por el equipo el 17 de noviembre de 2026. "Tramo" fue un nombre provisional y ya no se usa.

Restricciones que el equipo fijó con sus palabras:

- Debe sentirse como la aplicación real, lista para el usuario, y no como una demo preparada.
- Nada de apariencia genérica de interfaz hecha por IA.
- Moderno, minimalista, premium, bien pensado.
- Sin elementos que no cumplan una función y sin textos largos que repitan lo que ya se ve.
- El corte del edificio con la unidad del comprador es el elemento propio de la marca: debe transmitir originalidad, seguridad y modernidad.
- Punto de partida visual: la dirección "Plano de ventas" cruzada con el estándar de las apps financieras. El equipo descartó Boleta y Guía-mapa.

## Evidence on Hand

- Propuesta v6 con casos públicos y cifras referenciadas (Santa Cruz, La Paz, Defensa del Consumidor).
- PLAN.md con lo comprobado en Stellar Testnet y sus transacciones.
- No hay clientes, testimonios, logotipos de terceros, métricas de uso ni fotos de proyectos reales. Nada de eso se inventa.
- La operación de la demo es ficticia y debe poder reconocerse como tal donde alguien pudiera tomarla por real.

## Product Principles

1. El comprador nunca necesita una explicación técnica para actuar.
2. Lo que se ve en pantalla es lo que dice la red, al centavo.
3. Cada pantalla dice qué pasó, qué sigue y a quién le toca.
4. La plataforma es neutral y lo muestra: no decide, no retiene, no apura.
5. Lo simulado se rotula; lo real se puede comprobar.

## Accessibility & Inclusion

Español de Bolivia, en lenguaje llano. Uso con una mano en celulares Android de gama media. WCAG 2.2 nivel AA como objetivo propuesto, sin confirmar por el equipo.
