# Contrato de dirección de producto de ESQUORA

**MVP de preventa en Santa Cruz · edición del 18 de noviembre de 2026**

Una familia adelanta la cuota inicial de un departamento antes de que empiece la construcción. El desarrollador puede comprobar que el dinero está depositado. Para cobrarlo por la vía ordinaria, debe acreditar el inicio de la obra acordada y obtener la aprobación de esa familia. **La protección de ESQUORA termina al liquidarse el anticipo.** Si el edificio queda inconcluso después del cobro, el dinero ya entregado está fuera del alcance de este mecanismo.

Este documento fija qué debe construir y demostrar el equipo. Lo acompaña un modelo ejecutable en TypeScript, aislado de la aplicación. Los dos proyectos, las personas, las firmas representadas y los comprobantes del modelo son ficticios. El contrato inmobiliario de cada compraventa y una eventual autorización para manejar dinero real requieren su propia revisión.

## La decisión sobre el dinero

Cada comprador tiene un acuerdo para una unidad y hace un depósito completo. El inicio de obra de su proyecto, o de la etapa que corresponde a esa unidad, es el único hito de cobro. Un proyecto puede tener muchos acuerdos. El dinero y las autorizaciones de cada acuerdo se registran por separado.

| Suceso | Consecuencia económica |
|---|---|
| Se crea un borrador o se revisa la documentación | El comprador todavía no puede depositar. |
| El tercero acepta su designación y ambas partes firman el acuerdo revisado | La compradora puede solicitar el depósito íntegro mientras el anticipo siga teniendo sentido y esté dentro de plazo. |
| Se confirma el depósito | El importe completo pasa a protegido. El desarrollador ve los fondos comprometidos. |
| Se presenta un acta aplicable y la compradora aprueba esa versión | El desarrollador puede solicitar el cobro. Hasta que se confirma la liquidación, el saldo sigue protegido. |
| Vence el plazo para presentar la evidencia y falta un acta que acredite inicio en plazo | La compradora puede solicitar la devolución. La solicitud abre un caso. El tercero ejecuta la decisión documentada. |
| Hay evidencia discutida, falta de conformidad o instrucciones incompatibles | El importe sigue retenido mientras se tramita el caso. El silencio por sí solo no autoriza el pago. |

Para el piloto se busca un desarrollador que pueda financiar la excavación y que hoy pierda reservas porque las familias temen adelantar el dinero. Su incentivo sería convertir esas reservas en ventas y poder comprobar los fondos comprometidos. Para la familia importa qué obtiene desde el depósito, por ejemplo la reserva de una unidad a un precio y durante un plazo pactados. Ambas ventajas siguen siendo hipótesis comerciales.

## Antes de firmar

El desarrollador puede preparar el borrador con documentación pendiente. Para enviarlo a firma se necesita un expediente identificable y una revisión registrada. Se anotan proyecto, torre o etapa, predio, acuerdo de la unidad, responsable, fecha y huellas de las versiones revisadas.

| Pieza del expediente | Qué debe comprobar quien revisa |
|---|---|
| Contrato de preventa con su certificación | Correspondencia entre la versión certificada, la operación y la versión que se ofrece a la familia. |
| Registro del proveedor inmobiliario | Identidad del proveedor y vínculo con quien ofrece el proyecto. |
| Derecho sobre el terreno o facultad de disposición | Predio identificado y facultades de quien pretende vender. |
| Planos autorizados y permiso municipal de construcción | Proyecto, ubicación y etapa a los que alcanza la autorización. |

El DS 4732 exige certificación previa a la suscripción del contrato de preventa y contempla los planos autorizados y permisos para proyectos inmobiliarios. El DS 5690 crea el registro de proveedores. La revisión humana puede apoyarse en el emisor o en una fuente oficial. La huella sirve para reconocer la misma versión del archivo. La aplicación no adquiere facultades de certificación por calcularla. [DS 4732, artículos 3 a 5](https://faolex.fao.org/docs/pdf/bol211366.pdf) · [DS 5690, artículos 2 y 3](https://estaticos.unitel.bo/binrepository/ds-5690-de-registro-nacional-de-proveedores_101-16902254_20260901143006.pdf)

La referencia representa la revisión con una cuenta denominada *revisora*. Designar a la persona o institución real que asuma esa responsabilidad es una decisión del piloto. El expediente se cierra a cambios al firmar el desarrollador. La compradora acepta ese mismo acuerdo. Un cambio material posterior exigiría una nueva aceptación.

## El inicio de obra y las 40 familias

Antes del depósito las partes deben poder responder qué trabajo físico constituye inicio en ese predio, quién puede dar fe de él y hasta cuándo debe presentarse la prueba. Por ejemplo, pueden reconocer el comienzo de la excavación de cimentación de una torre identificada y pedir un acta firmada por el profesional pactado. La valla publicitaria, el movimiento de una máquina o una foto aislada dejan abierta la cuestión de qué trabajo empezó.

El acta incluye proyecto, torre o etapa, predio, trabajo observado, persona firmante, fecha física de inicio y versión. El sistema registra aparte la fecha de presentación. El modelo admite inicio y presentación exactamente en sus respectivos límites. Solo después de vencer el segundo plazo cabe pedir devolución por falta de acreditación. Así, un acta presentada el lunes puede acreditar trabajos del viernes si ambas fechas respetan lo pactado. En la referencia, el depósito solo se inicia antes del límite de inicio y mientras no haya un acta ya publicada para esa etapa.

El desarrollador publica una versión común. Cada compradora puede consultarla y aprobarla para su propio anticipo. Si 39 aprueban y la número 40 señala que su acuerdo menciona otra unidad, los otros 39 conservan sus autorizaciones. El tercero designado tramita el caso individual. Ninguna mayoría dispone del saldo de la número 40.

Si la observación aporta razones para pensar que el acta es de otro predio, la revisora puede registrar una incidencia común. Mientras se aclara, se detienen nuevas aprobaciones y solicitudes de cobro basadas en esa evidencia. Solo la revisión fundamentada levanta la incidencia. Una versión nueva requiere una aprobación nueva para cada cobro ordinario todavía pendiente de solicitar. Los movimientos ya enviados deben reconciliarse con la red. Las liquidaciones confirmadas siguen formando parte del historial.

## Quién decide y quién firma

| Participante | Facultad en la modalidad que se presenta al jurado |
|---|---|
| Compradora | Acepta su acuerdo, solicita el depósito, aprueba una versión del acta, objeta o solicita devolución de su saldo. |
| Desarrollador | Firma el acuerdo, presenta la evidencia, solicita el cobro autorizado y puede abrir un desacuerdo si falta conformidad. |
| Tercero externo | Acepta la designación antes de las firmas. En un caso abierto, registra la referencia de la decisión y ejecuta su destino. En la referencia de esta demo, un cobro controvertido también exige acta aplicable en plazo. |
| ESQUORA | Presenta las reglas y los importes, coordina la revisión y permite comprobar las transacciones. La cuenta de plataforma y el resolutor son distintos en esta modalidad. |
| Stellar | Confirma movimientos, firmas y saldo del contrato. Las personas evalúan la evidencia física y las condiciones pactadas. |

La aplicación existente también contempla un mandato de pruebas optativo para ejecución por ESQUORA. La demo elige desde el comienzo al tercero externo. Si una persona del equipo representa ese papel durante el ensayo, se identifica como tal. La frase que describe esta operación es «las partes eligieron a este tercero para ejecutar la resolución». [Modalidades de la aplicación](README.md#acuerdos-y-resolución)

## Cuánto dinero ve la familia

Importes ilustrativos en USDC de **Stellar Testnet**, sin valor real. Se conserva la política medida en los ensayos del equipo, con 0,9 % para ESQUORA y 0,3 % para Trustless Work sobre el bruto liquidado. En el ejemplo el depósito íntegro de 10.000 llega al saldo protegido. El descuento ocurre al liquidar por cualquiera de las dos salidas. [Resultado medido en Testnet](PLAN.md#3-decisiones)

| Movimiento de la demo | Depositado acumulado | Sigue protegido | Neto al desarrollador | Neto a la compradora | Comisiones |
|---|---:|---:|---:|---:|---:|
| Depósito confirmado en cualquiera de los proyectos | 10.000 | 10.000 | 0 | 0 | 0 |
| Proyecto Jacarandá tras el cobro | 10.000 | 0 | 9.880 | 0 | 120 |
| Proyecto Tajibo tras la devolución | 10.000 | 0 | 0 | 9.880 | 120 |

En cada fila, **depositado = protegido + entregado + devuelto + comisiones**. De los 120, corresponden 90 a ESQUORA y 30 a Trustless Work. Los 9.970 solo corresponden a un escenario en el que la plataforma reintegre sus 90. Para devolver íntegros los 10.000 también habría que cubrir los otros 30. La demo adopta el neto de 9.880. La cantidad que recibiría una cuenta bancaria en bolivianos dependería además de la conversión y sus costos.

La interfaz puede estimar importes antes de firmar. El resultado definitivo se toma de los movimientos verificados. Un envío pendiente, un rechazo y una transacción confirmada son estados distintos. Una espera de red mantiene el intento pendiente. Un rechazo definitivo permite reintentar si la autorización sigue vigente. Recibir dos veces el mismo comprobante produce una sola liquidación.

## Qué ve el jurado

| Momento | Qué mostrar y qué decir |
|---|---|
| 1. El anticipo | «La familia quiere reservar una unidad en Jacarandá. El desarrollador quiere saber si cuenta con esos fondos. Aquí está el expediente revisado y aquí, el depósito de 10.000 que ambos pueden ver». Si se muestra el bloqueo documental, usar un borrador incompleto que realmente impida avanzar. |
| 2. El intento de cobro | El desarrollador intenta cobrar antes de la aprobación. Mostrar el rechazo y volver al mismo saldo de 10.000. Identificar un rechazo registrado por su transacción. Si se usa una simulación o un comprobante histórico, nombrarlo en pantalla. |
| 3. La obra que sí empezó | Abrir el acta de Jacarandá, identificar predio, fecha, trabajo y firmante. La compradora aprueba esa versión. El desarrollador cobra. Mostrar neto y comisión al lado del comprobante. |
| 4. La obra que no acreditó el inicio | Cambiar visiblemente a **Tajibo**, otro proyecto ficticio, con depósito previo y plazo vencido. La compradora solicita devolución. El tercero externo ejecuta la resolución documentada. Mostrar 9.880 devueltos y 120 en comisiones. |
| 5. El cierre | Mostrar los dos expedientes con cero retenido y sus respectivos destinos. En el ensayo, preguntar cuánto quedaría en el escrow para devolver si Jacarandá se detuviera mañana. La respuesta es cero. |

La entrada y salida bancaria de la demo son simuladas. El ejemplo ejecutable de este directorio reproduce las reglas en memoria. Una demostración anunciada como transacción en Stellar necesita un comprobante verificable del expediente correspondiente. [Ejemplo histórico de cobro rechazado](https://stellar.expert/explorer/testnet/tx/80e06be2fdd92b9abb822b477492d353d4a793b970895fa338ad4e6e0eace2b8)

## Cómo ejecutar el contrato de referencia

Con las dependencias instaladas, el siguiente comando ejecuta el contrato desde la raíz del repositorio.

```sh
node --import tsx --test scripts/contrato-direccion.test.ts
```

Los dos primeros casos imprimen el resultado de Jacarandá y Tajibo. Los demás ejercitan los documentos previos, los plazos, las 40 aprobaciones individuales, las objeciones, los reintentos y la conservación del dinero. La ejecución es local y no precisa llaves ni saldo. [Modelo de referencia](scripts/referencia/contrato-direccion.ts) · [Ejemplos y pruebas ejecutables](scripts/contrato-direccion.test.ts)

En el código, `Etapa` conserva las versiones del acta y la incidencia común. Cada `Preventa` mantiene sus propias firmas representadas, aprobación, caso, intento pendiente y saldos. Los importes son centavos enteros y los tiempos se introducen en milisegundos UTC. Una petición de movimiento solo cambia el estado a `en_confirmacion`. El método `confirmarEnRed` consume un comprobante que un adaptador debe haber verificado previamente y contrasta operación, intento, destino e importes. La prueba suministra esos datos de forma determinista. La identidad de los actores, la correspondencia entre documento y huella, la competencia del firmante, la existencia física de la obra y la firmeza de una decisión son entradas verificadas fuera de este modelo.

## Diferencias con la aplicación y decisiones pendientes

La reserva disponible en la aplicación exige el expediente del proyecto y el contrato de la unidad antes de preparar el acuerdo. El desarrollador declara su revisión. Las firmas vinculan esas versiones a una sola condición de cobro. El prototipo usa una fecha límite de acreditación y un acta adjunta que las partes revisan. El registro independiente de una revisión profesional y la gestión de incidencias comunes entre varias unidades siguen descritos en el modelo de referencia. El recorrido con dos reservas independientes ya produjo un cobro y una devolución en Stellar Testnet. [Formulario](src/workspace.tsx) · [Acuerdo y depósito](server/app.ts) · [Comprobantes y ensayo](README.md#verificación)

| Decisión posterior | Evidencia necesaria para reabrirla |
|---|---|
| Inicial por calendario de abonos | Con 10.000 pactados y solo 5.000 ingresados, demostrar por separado cancelación y devolución del saldo, y cobro de ese saldo cuando la obra ya empezó. El depósito actual entra al saldo común del contrato. Crear hitos con nombres de cuotas no asigna por sí mismo los fondos a un hito. |
| Penalidad, reserva para cubrirla o reintegro de comisiones | Acordar quién paga, cuánto dinero estaría efectivamente disponible y qué decisión admisible permite ejecutarlo. El MVP usa una única cuota y una liquidación íntegra hacia uno de los dos destinatarios, con sus comisiones. |
| Desembolso al llegar a un mínimo de ventas | Verificar primero si el promotor necesita la inicial para financiar la excavación. Alcanzar un umbral para empezar y acreditar que la obra ya empezó trasladan riesgos distintos a la familia. También habría que acreditar la independencia de las reservas contadas. |
| Piloto con dinero real | Un promotor identifica proyecto y condiciones que aceptaría, un profesional acepta verificar el hecho físico, un tercero asume la resolución y un proveedor financiero confirma por escrito conversión, límites, tiempos y costos. Validar el encaje legal y el control independiente de las firmas. |
