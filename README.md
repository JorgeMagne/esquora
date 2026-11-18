# ESQUORA

Aplicación de preventas inmobiliarias sobre Stellar Testnet. Protege la cuota inicial por condiciones y deja comprobantes de depósito, pago y devolución. El banco y el proveedor financiero están simulados.

## Desarrollo local

1. Instala Node.js 22.22 o posterior y ejecuta `npm ci`.
2. Copia `.env.example` a `.env`. Configura las llaves de aplicación de Pollar y Trustless Work para Testnet.
3. Ejecuta `npm run dev` y abre [localhost:5173](http://localhost:5173).

El inicio prepara las cuentas de servicio de Testnet y comprueba su saldo. SQLite, los documentos y las claves de servicio se guardan en `DATA_DIR`. Conserva ese directorio entre reinicios. `ANCHOR_INITIAL_CENTS` controla el saldo inicial del proveedor simulado. Si la reserva inicial está en cero, el proveedor repone saldo cuando se necesita para un depósito.

## Acuerdos y resolución

Un borrador admite de uno a siete tramos editables y un contrato adjunto opcional. Los tramos reparten un único depósito. Para firmar el acuerdo, las partes deben tener una modalidad de resolución confirmada. La invitación a un tercero externo se comparte por enlace y solo se puede aceptar desde el correo indicado, con una cuenta de tercero activa.

Al migrar una base de datos anterior, ESQUORA guarda primero una copia de SQLite en `DATA_DIR` y comprueba las referencias dentro de la transacción de migración.

Para habilitar **ESQUORA verifica y ejecuta** en Testnet, configura `ESQUORA_RESOLVER_EMAIL` con el correo de una cuenta de tercero activa, distinta de las de comprador, desarrollador y cobro de comisiones. Las dos partes aceptan el mandato versionado al firmar el acuerdo. Ante un desacuerdo, presentan un reparto firmado por ambas o un documento emitido por la instancia pactada. La cuenta designada registra la verificación y el servidor solo prepara la transacción con los importes verificados. Una objeción invalida la instrucción antes del envío y conserva su registro en el historial de la operación.

El mandato es para el entorno de pruebas. Para dinero real se debe validar la documentación admisible, la vía de resolución y el control independiente de la firma.

## Verificación

- `npm run typecheck` comprueba los tipos.
- `npm test` ejecuta las pruebas locales en almacenamiento temporal.
- `npm run build` compila el sitio.
- `npm run e2e` ejecuta el recorrido real cuando `ESQUORA_RUN_TESTNET_E2E=1`. Crea cuentas y saldo de prueba, usa un servidor efímero enlazado a loopback y consulta los comprobantes de Stellar. El acceso de prueba solo se habilita en loopback con un token explícito y queda deshabilitado con `NODE_ENV=production`.

El ensayo interactivo usa tres perfiles de navegador con tres correos diferentes en Pollar. Activa primero al tercero designado, luego al desarrollador y al comprador. Crea un proyecto y una operación ficticia con dos condiciones y comparte la invitación con el correo exacto del comprador. Deposita en la pasarela de pruebas, comprueba la protección, presenta y confirma la primera condición y cobra desde la cuenta del desarrollador. Cuando venza la segunda, pide la devolución desde la cuenta del comprador, acéptala como desarrollador y ejecútala como tercero. Comprueba los tres saldos y los comprobantes. Mantén visible el rótulo de Testnet en la grabación.

## Despliegue HTTPS

El `Dockerfile` compila la web y sirve la API y la SPA desde el mismo proceso Hono. Pasa `VITE_POLLAR_PUBLISHABLE_KEY` como argumento público de compilación. Configura las llaves secretas como variables de ejecución. Usa un volumen persistente con permisos de escritura en `/app/data` y una sola réplica de Node. Monta la aplicación tras un proxy HTTPS y establece `APP_URL` con el origen público. Registra ese origen y sus direcciones de retorno en la aplicación Testnet de Pollar.

En producción, `ESQUORA_PREVIEW_CREDENTIALS` es obligatoria. Genera un código aleatorio de 32 bytes y codifícalo como Base64URL. Guarda el código en privado y configura el SHA-256 del texto Base64URL, seguido de dos puntos y una clave independiente de 32 bytes, ambos en hexadecimal. Configura este valor solo en el servidor. Al cambiar el código o la clave, todas las sesiones de acceso privado caducan. La sesión de acceso dura 12 horas y precede al inicio de sesión con Pollar.

La comprobación de salud es `GET /api/health`. Para levantar la compilación sin contenedor se puede ejecutar `npm run build` y `npm start` en un servidor con Node 22 y almacenamiento persistente. Si el proveedor reinicia Stellar Testnet, conserva el expediente y vuelve a crear las operaciones de prueba con las cuentas que se activen en la red actual.

En Railway, despliega el `Dockerfile` con una réplica y adjunta un volumen en `/app/data`. Configura la comprobación de salud `/api/health`, genera el dominio del servicio y usa su URL `https://` en `APP_URL` y en los dominios autorizados de Pollar Testnet. El contenedor ajusta los permisos del volumen al arrancar y ejecuta Node con el usuario `node`. Para iniciar un entorno de demo limpio, deja que el servicio genere sus propias llaves de Stellar Testnet en el volumen.

Consulta [PLAN.md](./PLAN.md) para los criterios de fase 1 y [DESIGN.md](./DESIGN.md) para la dirección visual.
