# ESQUORA | Protección de anticipos en la preventa inmobiliaria
Equipo ScaleNova · National Startups Hackathon by Stellar · Bolivia

**ESQUORA permite reservar un inmueble y mantener el anticipo protegido hasta que el promotor cumpla lo acordado.**

## El problema

Para que le reserven un departamento al precio ofrecido, al comprador pueden pedirle una inicial cuando la obra aún no está terminada. Si el promotor incumple o la oferta resulta fraudulenta, recuperar ese anticipo puede tomar años.

Estimamos que en Bolivia **unos USD 3,1 millones al año en anticipos de viviendas y lotes podrían verse afectados por incumplimientos o posibles estafas**. [Cálculo y fuentes](RESERVAS-INICIALES-Y-PERJUICIO-2026-11-21.md)

## La solución y cómo funciona

Con ESQUORA, el comprador puede reservar un departamento al precio acordado y mantener su anticipo protegido en Stellar hasta que el promotor acredite el avance pactado.

1. **Acuerdan la reserva.** Tras revisar la documentación del proyecto, comprador y promotor acuerdan la unidad, el precio, el plazo y qué avance permitirá cobrar. Con Pollar, cada uno entra con su correo y firma el acuerdo desde ESQUORA.
2. **El comprador deposita y el promotor aparta la unidad.** El anticipo queda retenido en un contrato de Trustless Work en Stellar. Ambos pueden verificar el saldo y el promotor mantiene la unidad y el precio durante el plazo acordado.
3. **El promotor acredita el avance y cobra.** Presenta la evidencia pactada. El comprador la revisa y, si está conforme, firma la aprobación desde ESQUORA. Con esa autorización, el promotor puede cobrar y ambos pueden comprobar el pago en Stellar.
4. **Si vence el plazo sin cumplimiento, el comprador puede pedir la devolución.** El saldo permanece en el contrato mientras el tercero designado revisa el caso. Si autoriza la devolución, el comprador puede verificar en Stellar cuánto recibió. [Reglas del producto](../CONTRATO-DE-DIRECCION.md)

## El mercado y el cliente inicial

Estimamos que en Bolivia se adelantan **entre USD 20 y 30 millones al año en iniciales de departamentos antes de la entrega**. Ese volumen equivale a unas 1.600–2.300 compras anuales con una inicial cercana a USD 12.800. [Cálculo del mercado](RESERVAS-INICIALES-Y-PERJUICIO-2026-11-21.md)

Cuando la misma compra empieza con una reserva de USD 1.000 y luego la descuenta de la inicial, ese primer tramo representaría USD 1,6 a 2,3 millones para esa cohorte. La promotora puede ofrecer ESQUORA por la reserva o por una inicial mayor, según cuánto pueda mantener depositado hasta el siguiente hito.

**Para promotores y desarrolladores**, una reserva protegida podría ampliar el mercado de sus proyectos. Un comprador de otra ciudad puede consultar las condiciones, firmar a distancia y comprobar dónde está su anticipo y qué debe cumplirse para que el promotor cobre. Esa confianza podría ayudar al proyecto a conseguir reservas más allá de su mercado local.

## Diferenciación y modelo de negocio

La transferencia directa con recibo y el fideicomiso bancario son alternativas disponibles. El fideicomiso puede administrar los fondos de un proyecto y ofrecer pagos condicionados. ESQUORA lleva esa mecánica a la reserva individual en la sala de ventas: el comprador ve su unidad, el saldo de su operación, la evidencia requerida y el importe neto que se pagaría o devolvería. [Comparación de alternativas en Bolivia](BANCOS-Y-COMPRADORES-EN-BOLIVIA.md)

El prototipo prevé una comisión del **0,9 % para ESQUORA** y del **0,3 % para Trustless Work** sobre el importe liquidado, tanto en cobro como en devolución. Las partes conocen los importes antes de depositar. [Modelo de comisiones](../CONTRATO-DE-DIRECCION.md)

## Qué mostramos en la demo

Dos proyectos, un depósito por operación y la misma condición de cobro: acreditar el inicio de obra del bloque contratado. En una operación, el promotor presenta el acta, el comprador la aprueba y se libera el dinero. En la otra, vence el plazo sin acreditación, el comprador solicita la devolución y el tercero designado ejecuta la resolución. La pantalla muestra cuánto entró, cuánto recibió cada parte y la transacción que lo acredita.

**Por qué Stellar.** El anticipo queda en un contrato en Stellar. Comprador y promotor pueden verificar el depósito y, al cerrar la operación, comprobar quién recibió el dinero y cuánto. Esa comprobación se puede hacer desde el explorador público, incluso fuera de ESQUORA.

- **Pollar** permite entrar con correo, acceder a una billetera Stellar y firmar desde la aplicación. Cada parte confirma las acciones que le corresponden. [Implementación de firmas](../src/signing.tsx)
- **Trustless Work** aporta el contrato de pago condicionado en Stellar. Retiene el anticipo y aplica las autorizaciones de cobro o resolución. La evidencia de obra la revisan las personas designadas en el acuerdo. [Integración del contrato](../server/tw.ts)
- **Prueba para el jurado.** El último ensayo recorrió dos reservas independientes en Stellar Testnet. Se depositaron 200 USDC de prueba en cada operación. El promotor recibió 197,60 en una y el comprador recuperó 197,60 en la otra. [Cobro](https://stellar.expert/explorer/testnet/tx/95fd64ec25e11e4c65b3be195fa08df4d744a03aee49ad27519bdd170c0f7b93) · [Devolución](https://stellar.expert/explorer/testnet/tx/6a77605c857e54fcd80a8f25d2025ab2ff9d4e29ce96d72a6cb74e172080e17a) · [Guion y comprobantes de ambos depósitos](../README.md)

## Próximo paso y proyección

En los próximos 30 días proponemos probar la reserva protegida con una promotora. Primero identificaremos qué importe puede mantener retenido y qué condición aceptan ambas partes. Después ofreceremos la modalidad en sala de ventas a interesados que ya eligieron unidad y mediremos cuántos la eligen, cuántas reservas se concretan y cuánto cuesta cada operación. La siguiente aplicación dentro de la preventa son pagos condicionados a otros avances verificables, como el fin de obra gruesa o la entrega de la unidad.

## Pitch

En Bolivia, para reservar un departamento al precio de preventa, a veces hay que adelantar la inicial mientras la obra sigue pendiente. Estimamos que cada año unos 3 millones de dólares en anticipos inmobiliarios podrían verse afectados por incumplimientos o posibles estafas. Con ESQUORA, el comprador puede reservar la unidad y mantener su anticipo protegido en Stellar. Entra con su correo mediante Pollar y firma el acuerdo. Un contrato de Trustless Work retiene el dinero. El promotor ve el depósito y cobra cuando acredita el avance pactado y el comprador lo aprueba. Si vence el plazo sin cumplimiento, el comprador puede solicitar la devolución. En ambos desenlaces, el jurado puede abrir Stellar y comprobar adónde fue el dinero. Empezamos en un mercado que estimamos entre 20 y 30 millones de dólares al año en iniciales de departamentos en Bolivia.
