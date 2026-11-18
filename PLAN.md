# Plan de ejecución — pagos inmobiliarios asegurados sobre Stellar

Versión 5, 17 de noviembre de 2026. Incorpora las dos evaluaciones del equipo, los resultados y el cierre de la fase 0 (2.1 y 7), la decisión del tercero como resolutor (3.1) y lo que hay que construir en la fase 1 (sección 8). Producto: **ESQUORA**.
Tecnología fijada por la propuesta: Stellar Testnet, Trustless Work V1 (escrow) y Pollar (acceso y billetera).

Cada afirmación técnica lleva una de tres marcas:

- **[Testnet]** lo ejecuté en Stellar Testnet y pasó.
- **[Fuente]** está en el código del contrato, en el Swagger de la API o en los tipos del SDK.
- **[Por probar]** solo se confirma con las llaves de API. Cada uno tiene su prueba en la fase 0.

Cambios respecto a la versión 1:

| Tema | Antes | Ahora |
|---|---|---|
| Firma de la resolución | Tres rutas, la tercera con llave y PIN propios | Dos rutas con Pollar; si fallan, el tercero designado es el único resolutor. Sin llaves propias |
| Comisiones en devoluciones | Reembolso automático del 100 % | Se decide con los montos medidos en Testnet |
| Activo | USDC propio, Circle como respaldo | Se prueban los dos el primer día; el propio se llama `TRAMOUSD` |
| Alcance | Seis fases del mismo peso | Tres niveles de prioridad y calendario al 22 de noviembre |
| Pruebas | Solo flujos válidos | Se agregan firma diferida, permisos negativos y reconciliación |
| Producto (versión 3) | Sin especificación de pantallas | Sección 5: vocabulario, plantilla de preventa, recorridos por tipo de cuenta y vista de verificación |

---

## 1. Qué se entrega

Una aplicación web desplegada con HTTPS donde una preventa completa ocurre de verdad en Testnet, entre un comprador, un desarrollador y un tercero designado.

La prueba que decide si el MVP tiene sustancia es esta secuencia, verificable en el explorador público:

1. Desplegar un escrow real de Trustless Work V1.
2. Depositar fondos.
3. Aprobar y liberar un tramo.
4. Abrir un desacuerdo sobre otro tramo.
5. Resolverlo y devolver los fondos.
6. Comprobar todos los saldos y movimientos en Stellar.

Reglas para que no parezca demo:

1. Nada en pantalla que no funcione.
2. Ningún dato escrito en el código. Los datos de ejemplo se crean usando la app.
3. Los montos de pantalla salen de la red y coinciden con el explorador al centavo.
4. Lo simulado (banco y proveedor financiero) vive en una pasarela aparte, rotulada "entorno de pruebas".

---

## 2. Lo que ya está comprobado

| Hecho | Marca | Evidencia |
|---|---|---|
| Una cuenta con 3 firmantes y umbral 2 autoriza una llamada a un contrato Soroban con dos firmas | [Testnet] | `scripts/spikes/soroban-multisig.ts`, prueba P1 |
| Con una sola firma la red la rechaza y no queda registrada | [Testnet] | prueba P2 |
| Un intento inválido puede quedar registrado como transacción fallida, visible en el explorador | [Testnet] | prueba P3: [transacción fallida](https://stellar.expert/explorer/testnet/tx/bec9e5e3ab4573774952d9b5c31308ba04cc1a56851cdc5a589282f663cda8a0) |
| La cuenta de 3 firmas también autoriza cuando no es el origen de la transacción | [Testnet] | prueba P4 |
| Cualquiera puede depositar en el escrow; el saldo es el saldo real del token en el contrato | [Fuente] | `core/escrow.rs` |
| Se puede abrir un desacuerdo sobre un tramo que nunca se marcó como cumplido | [Fuente] | `validators/dispute.rs` |
| El rol de resolución solo puede mover un tramo que está en desacuerdo | [Fuente] | error 31 `MilestoneNotInDispute` |
| La plataforma no puede mover fondos ni cambiar roles mientras haya saldo | [Fuente] | `update_escrow` |
| La plataforma sí puede abrir un desacuerdo y recibe la comisión | [Fuente] | `validators/dispute.rs` |
| Pollar firma transacciones de Trustless Work con `signTx` | [Fuente] | demo oficial de Pollar |
| El backend puede verificar al usuario de Pollar | [Fuente] | `POST /v3/tokens/verify` |

Alcance de las pruebas P1 a P4: se hicieron contra un contrato de token, no contra un escrow de Trustless Work. Demuestran que el mecanismo funciona en la red. La integración con el escrow se da por buena solo cuando pasen S5 y S6.

### 2.1 Resultados de la fase 0 (17 de noviembre)

Corridas contra la API V1 de Trustless Work y su contrato en Testnet, con cuentas de prueba y el activo `TRAMOUSD`. Script: `scripts/spikes/fase0.ts`. Estado y resultados completos: `data/fase0-state.json`.

Escrows de prueba: [principal](https://stellar.expert/explorer/testnet/contract/CB3U47BH2NCFK5ESMVSY2XO65JTA4N7VWQ2YTHXD6UES4AMO6SZ7NCPU) · [protección](https://stellar.expert/explorer/testnet/contract/CDTXSAAU4EQOXX7JH4Y3G4WV5IX2SJI5TBDHSH3HCD7DYIA26OMAKJVF) · [USDC de Circle, sin fondos](https://stellar.expert/explorer/testnet/contract/CBYTWZV7ETGZS7EOXJQVMOGCPG23JPHQG2SW6BBR4LPFKMDT5JDPMNGR)

| Prueba | Resultado | Lo que cambia |
|---|---|---|
| S1 Despliegue | Pasa con `TRAMOUSD` y con USDC de Circle. `roles` y `trustline` van como objetos; `trustline.address` es el emisor (G…) | La API exige una línea de confianza al **USDC de Circle** en el receptor, en la plataforma y en quien deposita, sea cual sea el activo del escrow |
| S2 Transacciones | Origen = la cuenta del rol que firma. Autorización `sourceAccount`. **Vencen a los ~100 segundos.** `platformFee` es porcentaje: `0.9` queda como 90 puntos básicos | Cada firma se pide justo después de armar la transacción |
| S3 Depósito | [12.000 depositados](https://stellar.expert/explorer/testnet/tx/a502d5bd9149af43232b9d11298917677d7ae8e6199cda3fe8eb3089692db16a); el saldo leído de la red coincide | El endpoint de saldos de la API pide `addresses[]=`; se lee de la red |
| S4 Liberación con `TRAMOUSD` | **La API no la arma**: responde "Escrow not found", después de validar roles y confirmación. Igual con la resolución | Por la regla de 3.4, el activo es **USDC de Circle** |
| S4 Montos (llamando al contrato) | [Tramo de 6.000](https://stellar.expert/explorer/testnet/tx/19d1a92a4344e9575b8902f80b53069be22318f73ff4d0953b1036b8acf6a202): desarrollador 5.922, plataforma 60 (1 %), Trustless Work 18 (0,3 %) | Con 0,9 %: el desarrollador recibe 98,8 % |
| S5 Devolución 2 de 3 | [Comprador + desarrollador](https://stellar.expert/explorer/testnet/tx/3e46ed1d04298efe813f3ff3f8b870a24c9646790e583a9ddf4fdc95b05ca6bb), sin el tercero. De 3.000, el comprador recibió **2.961**: también se descuentan las dos comisiones | Ver 3.2 |
| S6 Firma diferida | Transacción guardada antes de otra operación de la cuenta de resolución: rechazada (`tx_bad_seq`). Con una sola firma: rechazada y no registrada. Rearmada con ventana de un día: [segunda firma 2 min 40 s después, en otro proceso, ejecutada](https://stellar.expert/explorer/testnet/tx/91cf41e0117cc7845f59a98ad1cf9a942b845756e3352bcaa3f0cf7d102f9cb5) | La app rearma la resolución con ventana larga y la vuelve a armar si la cuenta de resolución firmó otra cosa |
| S9 Intentos en la red | Cuatro transacciones fallidas registradas, saldo intacto en 2.000: [desarrollador cobra sin confirmación (#29)](https://stellar.expert/explorer/testnet/tx/80e06be2fdd92b9abb822b477492d353d4a793b970895fa338ad4e6e0eace2b8) · [comprador retira (#37)](https://stellar.expert/explorer/testnet/tx/4f9fbfc4654bc332d3e721cbbd833b674e76ae4ce9abf9c0233f3530e46946ad) · [comprador resuelve a su favor (#37)](https://stellar.expert/explorer/testnet/tx/6998e688f5a37a9d46e394ef2779ccabd5a27e5e72094ee0a50b400a7ff135e1) · [plataforma retira (#37)](https://stellar.expert/explorer/testnet/tx/d79a66bdbf9d7b6b18569fef5bd8ee37765c0bf77ab92507df2c71b67590608c) | El paso 3 de la demo se cumple tal como lo escribe la propuesta |
| S10 Permisos | 14 intentos, 14 rechazos. Entre ellos: la plataforma no puede cambiar el destinatario con fondos depositados (contrato, #15) y el tercero no puede abrir un desacuerdo | — |
| S7 Pollar | **Pasa** (17 nov, inicio de sesión por correo, billetera `internal`). Verificación del token en el backend: `SERVER_TOKEN_VERIFIED`, devuelve la dirección de la billetera. Línea de confianza al USDC de Circle: pasa, **pero la app no la patrocina**: sin XLM falla con `TX_LOW_RESERVE` (hacen falta 0,5 XLM). SEP-53: firma válida de la huella del acuerdo, sin ventana de confirmación. `signTx` de una transacción de Trustless Work cuyo origen es la billetera: [confirmación del tramo 1](https://stellar.expert/explorer/testnet/tx/8693b51ea618dcdde4181056c2e3cdb3c2eb0574e5619556a393abded05d2315), misma transacción, sin fee-bump con `skipSponsorship` | Pollar **muestra su ventana de confirmación** ("Confirm transaction", en inglés) en cada `signTx` y al agregar el activo, este último con el activo como JSON crudo. La plataforma debe enviar XLM antes de la línea de confianza (4.5) |
| S8 ruta A (`signTx`, origen = cuenta 2 de 3) | **Falla**: `TX_SIGN_FAILED`, "The transaction source (tx.source) must match publicKey" | Pollar no firma transacciones de otra cuenta. Ruta A descartada |
| S8 ruta B (`signAuthEntry`, origen = plataforma) | **Falla.** Tres intentos con la billetera real: sin política, `403 SOROBAN_AUTH_NO_POLICY`. Con una política temporal (solo el contrato de prueba y `resolve_milestone_dispute`; borrada al terminar) y la entrada V2 que da la simulación, `400 SOROBAN_AUTH_ENTRY_INVALID` (Pollar solo acepta credenciales V1). Con la entrada convertida a V1, `403 SOROBAN_AUTH_ADDRESS_MISMATCH`: "entry authorizes <cuenta 2 de 3>, not the requesting wallet". La red sí acepta V1 (simulación estricta: dos firmas pasan, una se rechaza) y la mecánica pasó en la red con llaves locales ([ensayo](https://stellar.expert/explorer/testnet/tx/9a649469b6c944713b6255b1fe1945817645b32abd0e8cb15b786f82ca09b0dc)) | **Pollar solo firma a nombre de la propia billetera**, por cualquiera de las dos vías. Ruta B descartada. Datos de la política, por si se usa en otra cosa: `contract_id` exacto o `*`, funciones por nombre, ventana máxima de 300 ledgers (~25 min) |
| USDC de Circle (C0) | Sin faucet: XLM del friendbot cambiado en el pool de liquidez de Testnet (93 M XLM / 67 M USDC). [12.000 USDC por 16.731 XLM](https://stellar.expert/explorer/testnet/tx/7205b7cdc1aadd48d2d2fc2102e6fd266d22426a147a452e3c84bf7351b30d20) | La demo puede usar la cuota inicial real de 12.000. Cada 10.000 XLM de friendbot dan ~7.200 USDC |
| S1 y S3 con USDC de Circle por la API | [Escrow con la plantilla de preventa](https://stellar.expert/explorer/testnet/contract/CDZFE5NSOTEVIPR5EC6P5ZA3XGEO2ZVXHCAYJ43LLAZGJIXDP3ACRSTR) (6.000 + 6.000, comisión 0,9 %); [depósito de 12.000](https://stellar.expert/explorer/testnet/tx/da863582d07e439d3ea6792fb766e768e10244edf722de3ac78d77bb0042e401), saldo en la red 12.000 | — |
| S4 por la API con USDC de Circle | **Pasa.** [Evidencia](https://stellar.expert/explorer/testnet/tx/f216448d59dc267646a1bf627530c942badd1e8fd5d9aeab7ae2be41edb94556) · [confirmación](https://stellar.expert/explorer/testnet/tx/4013c790aaab6d3599cf9620616c35ea7834b5a335601a4fa458e13bcb0bcb19) · [liberación](https://stellar.expert/explorer/testnet/tx/d72aac3560ff22719add3009ecf93d45cd9babffa9fa05b0459f8d66bf13d2a1). De 6.000: desarrollador **5.928** (98,8 %), plataforma 54 (0,9 %), Trustless Work 18 (0,3 %, cuenta `GA6KH5…CK7G` puesta por la API) | El "Escrow not found" era por el activo: con USDC de Circle la API arma todo |
| S5 por la API con USDC de Circle | **Pasa.** [Desacuerdo](https://stellar.expert/explorer/testnet/tx/9763259c8cc6356d42403595a1061f7a42759a036a971fbd8bbadf7334f0f004) y [devolución 2 de 3](https://stellar.expert/explorer/testnet/tx/dbda702f18d8f800470cc3356153a8d32fb62328f5a01dda1189b694501c52a2) (comprador + desarrollador; origen = cuenta 2 de 3). El comprador recibe **5.928 de 6.000**; escrow en 0 | La secuencia de la sección 1 corre completa por la API |

Corrección: la primera verificación de la cuenta 2 de 3 marcó `ok: false` por un error del script, no de la cuenta. Horizon también lista la llave maestra (con peso 0). La comprobación correcta cuenta solo los firmantes con peso y exige la maestra en 0; con esa regla la cuenta pasa. Si alguna vez se retoma una cuenta compartida, esa es la regla que hay que usar.

Hallazgo de la red: Testnet ya emite entradas de autorización `sorobanCredentialsAddressV2` (CAP-71), donde la dirección forma parte de lo que se firma. Afecta a la ruta B de 3.1: quien firme la entrada (Pollar) tiene que soportar V2. `@stellar/stellar-sdk` 17 lo soporta.

Dos hallazgos del contrato que no estaban en la documentación:

- **La cuenta de comisión de Trustless Work la pone quien llama.** `release_milestone_funds`, `resolve_milestone_dispute` y `withdraw_remaining_funds` la reciben como argumento y el contrato no la valida. No afecta el dinero del comprador ni del desarrollador, pero la app debe usar siempre la que pone la API.
- **Solo el resolutor mueve un tramo en desacuerdo, y solo si está en desacuerdo** (#31 y #37). La plataforma no tiene ninguna función que mueva fondos.

---

## 3. Decisiones

**3.1 Firma de la resolución.** Pollar, por política documentada, solo firma transacciones de la cuenta del propio usuario. Eso choca con una cuenta de tres firmas. [Fuente; comportamiento real por probar]

Se prueban dos rutas el primer día. Si ninguna funciona, el rol de resolución lo ocupa directamente el tercero designado, como ya prevé la propuesta v6. No se construyen llaves propias con PIN: una copia cifrada con un PIN corto se puede descifrar por fuerza bruta desde la base de datos, y eso anula la promesa de que la plataforma no puede firmar.

La fase 0 termina con una sola ruta elegida y probada.

Esta prueba decide además si el producto coincide con la propuesta. La v6 promete que comprador y desarrollador ejecutan solos una devolución acordada. En Trustless Work eso solo es posible con la cuenta de tres firmas. Si ninguna ruta de Pollar funciona, el tercero ejecuta lo que ambos acordaron, y la propuesta y las pantallas lo dicen así, sin ocultarlo.

**Resultado (17 nov, S8 en 2.1):** fallan las dos rutas. Pollar rechaza firmar una transacción cuyo origen no es la billetera (`TX_SIGN_FAILED`) y una autorización cuya dirección no es la billetera (`SOROBAN_AUTH_ADDRESS_MISMATCH`). Por la regla de arriba, **el rol de resolución lo ocupa el tercero designado**. Una devolución acordada la ejecuta el tercero a pedido de las dos partes, y la propuesta y las pantallas lo dicen así.

**Decisión del equipo (17 nov): el tercero designado resuelve.** Se construye así para la entrega. Si queda tiempo después de P0 y P1, se exploran las opciones que conservan la devolución entre las dos partes, en este orden: el contrato propio como resolutor (abajo) y, solo si ese falla, la llave en el navegador.

Opción sin probar que conserva la promesa y es compatible con Pollar: un contrato propio como `disputeResolver`. Cada parte envía su propia transacción ("acepto devolver") con origen en su billetera, el caso que S7 demostró que Pollar firma. Al reunir dos de tres, el contrato llama a `resolve_milestone_dispute`. No tiene ventana de 25 minutos, porque las aceptaciones quedan en la red. Exige escribir y desplegar un contrato Soroban sin auditar, y comprobar que Trustless Work admite una dirección de contrato (C…) como resolutor. No se construye salvo decisión expresa del equipo.

Alternativa que el equipo puede elegir en ese caso, si pesa más la promesa que la simplicidad: una llave guardada solo en el navegador de cada usuario, sin PIN y sin copia en el servidor. Evita el problema de fuerza bruta, pero se pierde al cambiar de dispositivo y no está probada. No se construye salvo decisión expresa.

**3.2 Comisiones en devoluciones.** Medido en Testnet (S5): una devolución descuenta el 0,3 % de Trustless Work y la comisión de la plataforma, igual que una liberación. Con 0,9 %, de USD 6.000 el comprador recibe USD 5.928. [Testnet]

Falta que el equipo elija entre:

- Mostrar la devolución neta y decirlo antes de firmar el acuerdo.
- Que la plataforma reembolse la diferencia con una segunda transacción. En ese caso se presenta como dos operaciones, no como una devolución garantizada.

**3.3 Plazos.** Trustless Work no tiene fecha límite ni devolución automática (issue #132). [Fuente] El plazo lo controla la aplicación; vencido, el comprador abre el desacuerdo en la red.

**3.4 Activo.** Se prueban dos el primer día, cambiando un solo parámetro:

| Activo | Ventaja | Límite |
|---|---|---|
| `TRAMOUSD`, emitido por una cuenta nuestra | Montos realistas (cuota inicial de 12.000) | La liberación falla si la dirección de comisión de Trustless Work no lo acepta [Por probar] |
| USDC de prueba de Circle | Trustless Work lo usa en sus ejemplos | El faucet entrega montos pequeños |

Regla de elección: si `TRAMOUSD` libera correctamente en S4, se usa ese. Si no, Circle. El activo propio nunca se muestra como "USDC"; en pantalla se lee "USD de prueba (TRAMOUSD)".

**Resultado:** `TRAMOUSD` no libera por la API (S4). **Se usa USDC de Circle.** [Testnet] Consecuencias:

- Toda cuenta que reciba, deposite o sea plataforma necesita la línea de confianza al USDC de Circle (emisor `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`). En Pollar se habilita para todos los usuarios con `POST /v3/assets/enable`.
- El proveedor financiero simulado obtiene USDC de prueba de Circle cambiando XLM del friendbot en el pool de Testnet (C0 en 2.1); no hace falta el faucet y la demo usa 12.000.
- Confirmado con USDC de Circle: la API arma la liberación y la resolución (S4 y S5 en 2.1).

**3.5 Paso 3 de la demo.** Llamando al contrato de Trustless Work directamente, el intento no autorizado queda registrado como transacción fallida y se ve en el explorador; el saldo no se mueve. [Testnet, S9] La vista de verificación arma esa llamada; por la API el intento se rechaza antes de llegar a la red.

**3.6 Qué prueba la firma y qué no.** La red comprueba que hay firmas suficientes. No comprueba que un documento sea auténtico, que un plazo haya vencido ni que una decisión sea jurídicamente válida. Comprador y tercero podrían autorizar una devolución sin que el desarrollador haya incumplido. Es parte del diseño: la resolución es externa y la red solo ejecuta. El pitch no presenta la multifirma como garantía jurídica.

Otras precisiones para el pitch:

- La plataforma no mueve fondos, pero el contrato le permite abrir un desacuerdo, que congela un tramo. La app no expone esa función.
- En modo de pruebas, Pollar guarda las llaves de los usuarios. En producción usa Turnkey y deja de guardarlas.
- Si el tercero queda como único resolutor: actúa solo cuando una parte abrió un desacuerdo, y a partir de ahí decide solo adónde va ese tramo.

---

## 4. Diseño

### 4.1 Piezas

| Pieza | Elección |
|---|---|
| Web | React 19, Vite, Tailwind 4, `@pollar/react` 0.12.0 con versión fija |
| API | Node 22, Hono, SQLite en disco persistente |
| Escrow | API V1 de Trustless Work, `https://dev.api.trustlesswork.com`, multi-release |
| Red | Horizon y Soroban RPC de Testnet, `@stellar/stellar-sdk` 17 |
| Archivos | Disco del servidor, nombrados por su SHA-256 |

### 4.2 Roles en Trustless Work

| Rol del contrato | Quién | Por qué |
|---|---|---|
| `approver` | Comprador | Confirma cada tramo |
| `serviceProvider` | Desarrollador | Presenta evidencia |
| `releaseSigner` | Desarrollador | Cobra un tramo ya aprobado y sin desacuerdo. En pantalla: "Recibir pago aprobado". La plataforma nunca ocupa este rol, aunque eso haría la liberación automática, porque pasaría a firmar en el camino del dinero |
| `receiver` de cada tramo | Desarrollador | Recibe el pago |
| `disputeResolver` | Tercero designado (su billetera Pollar) | Pollar solo firma a nombre de la propia billetera (S8). Decidido el 17 nov (3.1) |
| `platformAddress` | Cuenta de la plataforma | Configura antes del depósito y recibe la comisión |
| Quien despliega (`signer`) | Cuenta de la plataforma | No obtiene ningún rol |
| Quien deposita | Proveedor financiero simulado | Cualquiera puede depositar |

### 4.3 Resolución

**El tercero designado es el único resolutor** (decidido el 17 nov, 3.1). El `disputeResolver` de cada escrow es la billetera Pollar del tercero.

- **Devolución por plazo vencido.** El comprador pide la devolución, y eso abre el desacuerdo en la red (`dispute-milestone`, firmado por el comprador). El desarrollador tiene un plazo para responder en la app: acepta o rechaza con motivo; esto queda solo en la base de datos. Si acepta, el tercero ejecuta la devolución tal como la acordaron. Si rechaza o no responde a tiempo, el tercero decide.
- **Desacuerdo.** Lo abre el comprador o el desarrollador. El tercero ve el acuerdo, los documentos y los motivos de cada parte, y ejecuta el reparto (`resolve-milestone-dispute`, firmado por el tercero; puede ser parcial).
- **Toda firma de usuario es sobre su propia billetera**: el comprador confirma y abre desacuerdos, el desarrollador presenta evidencia y cobra, el tercero resuelve. Es el caso que S7 comprobó con Pollar. No hay solicitudes de firma compartidas que guardar ni rearmar.
- **Vencimiento de ~100 s** de las transacciones que arma la API (S2): la app arma la transacción justo cuando la persona pulsa el botón, la firma y la envía en el mismo paso. Si venció mientras la ventana de Pollar estaba abierta, la rearma y vuelve a pedir la confirmación, explicándolo.

Lo que queda de la cuenta 2 de 3 está en la fase 0 (2.1) como evidencia, y como mejora posible en 3.1.

### 4.4 Comisiones

Medido en Testnet: la API recibe `platformFee` como porcentaje (`0.9`) y el contrato lo guarda como 90 puntos básicos. En cada liberación y en cada devolución, de cada tramo se descuentan 0,3 % para Trustless Work y 0,9 % para la plataforma; el resto (98,8 %) va al destinatario. Con USD 6.000: 5.928 al destinatario, 54 a la plataforma, 18 a Trustless Work.

### 4.5 Acceso y sesión

1. El usuario entra con Pollar (Google o código por correo).
2. La web envía el token de Pollar al backend una sola vez.
3. El backend lo valida con `POST /v3/tokens/verify` y crea su propia sesión por cookie.
4. En el primer ingreso el usuario elige tipo de cuenta y completa su perfil. La plataforma le envía XLM de prueba para comisiones de red.
5. Después, la billetera habilita el USDC de Circle (`setTrustline`). Hace falta para el comprador (recibe devoluciones) y el desarrollador (recibe pagos); el tercero no lo necesita. Comprobado en S7: sin XLM falla con `TX_LOW_RESERVE`, y Pollar muestra su ventana de confirmación. La app lo presenta como "Activar tu cuenta", un solo paso.

Comprobado en S7: `/v3/tokens/verify` responde `SERVER_TOKEN_VERIFIED` con la dirección de la billetera; el token se lee en `getClient().getAuthState().session.token.accessToken` (accesor no documentado por Pollar). Plan B si deja de funcionar: desafío SEP-10 firmado con `client.stellar.sep10.sign`.

Pantalla de inicio de sesión: la ventana de Pollar está en inglés y lleva su marca. Se usa en P0. En P1 se reemplaza por una pantalla propia en español que usa el SDK por detrás (`login({ provider: 'google' })`, `beginEmailLogin`, `sendEmailCode`, `verifyEmailCode`).

### 4.6 Huellas y firma del acuerdo

- El acuerdo es un JSON con partes, montos, tramos, condiciones, plazos y el SHA-256 del contrato. Su SHA-256 es la huella del acuerdo.
- Ambas huellas van en el campo `description` del escrow y quedan en la red desde el despliegue.
- Desarrollador y comprador firman la huella con `signMessage` de Pollar (SEP-53).
- La evidencia de cada tramo se registra en la red como la huella de su lista de documentos.

### 4.7 Banco y proveedor financiero simulados

Página separada, con otro estilo y el rótulo "entorno de pruebas". Al confirmar el pago, la cuenta del proveedor deposita en el escrow con `fund-escrow`. El retiro a banco es un pago real en Testnet hacia la cuenta del proveedor.

### 4.8 Consistencia entre la base de datos y la red

- Ningún estado pasa a "depositado", "liberado" o "devuelto" por una respuesta de la API. El backend consulta la transacción en la red y solo cambia el estado cuando figura como exitosa.
- Cada transacción enviada se guarda antes con su hash y estado "enviada".
- Al arrancar, y cada vez que se abre una operación, el backend compara su estado con el del escrow en la red y corrige lo que difiera.
- Si la red y la base no coinciden, manda la red.

### 4.9 Permisos

Cada acción del backend comprueba que quien la pide es parte de esa operación y tiene el rol que corresponde. El tercero solo ve una operación cuando hay un desacuerdo o una devolución pendiente.

---

## 5. Experiencia de usuario

### 5.1 Criterio de producto

Tramo funciona como una plataforma de pagos inmobiliarios comprensible para personas sin conocimientos técnicos. Comprador y desarrollador interactúan con inmuebles, documentos, importes, condiciones y pagos. La tecnología queda en segundo plano.

Ninguna operación requiere que el usuario entienda qué es USDC, una billetera, un contrato inteligente, una comisión de red, una firma multifirma o una dirección. Las funciones técnicas siguen disponibles para verificación, sin convertirse en pasos del usuario.

Prueba de fidelidad: una persona que nunca oyó hablar de Stellar entra, identifica el inmueble, entiende las condiciones, deposita su cuota inicial, ve su dinero protegido y gestiona una confirmación o una devolución sin recibir una sola explicación técnica.

### 5.2 Vocabulario

| Concepto técnico | Lo que lee el usuario |
|---|---|
| Escrow | Dinero protegido |
| Milestone | Condición (tramo 1, tramo 2) |
| Aprobar un milestone | Confirmar |
| Liberar fondos | Recibir pago aprobado |
| Disputa para devolución | Pedir devolución |
| Disputa | Desacuerdo |
| Resolutor | Tercero designado |
| Activo (TRAMOUSD o USDC) | USD, con la cotización en bolivianos al pagar |
| Billetera | Mi saldo |
| Firma | Confirmar |
| Hash de transacción | Comprobante, con el enlace "Ver en el registro público" |
| XLM y comisiones de red | No aparecen |

El nombre del activo de prueba, las direcciones y los roles del contrato aparecen solo en la vista de verificación.

### 5.3 Plantilla de preventa

Toda operación nueva parte de esta plantilla. Las partes pueden ajustar importes, plazos y reparto, pero la demo usa la plantilla tal cual.

**Tramo 1 — Documentación del proyecto**

| Documento | Guía para el comprador |
|---|---|
| Contrato certificado por Defensa del Consumidor | Que sea el mismo contrato que firmó; la app compara la huella |
| Registro del proveedor inmobiliario | Que esté a nombre de este desarrollador |
| Derecho sobre el terreno | Que el titular sea el desarrollador o exista un documento que lo vincule |
| Permiso municipal de construcción | Que corresponda a la dirección del proyecto y esté vigente |

**Tramo 2 — Inicio de obra**

La v6 no define qué evidencia acredita el inicio de obra. Propuesta por confirmar con el equipo: acta de inicio de obra y fotografías fechadas del terreno.

Los textos de guía son una propuesta y los valida quien dé la opinión legal. Reparto por defecto: 50 % y 50 %.

### 5.4 Recorridos

**Comprador**

| Pantalla | Qué ve | Acción |
|---|---|---|
| Invitación | El inmueble, el desarrollador, la cuota inicial y una frase: su dinero queda protegido hasta que se cumpla cada condición | Entrar con Google o correo |
| Acuerdo | Inmueble, precio, cuota inicial, las dos condiciones con sus documentos y plazos, el tercero designado, el contrato y los costos | Aceptar acuerdo |
| Pago | Importe en USD y en bolivianos, cotización y vencimiento | Pagar desde mi banco (pasarela de pruebas) |
| Mi operación | "Tu departamento A-302", dinero protegido, entregado y devuelto, cada condición con su estado, qué sigue y a quién le toca | Según el estado |
| Revisar documentos | Cada documento con su guía | Confirmar u objetar |
| Plazo vencido | Qué condición venció y cuánto dinero sigue protegido | Pedir devolución |
| Devolución en curso | Quién debe responder y hasta cuándo | — |
| Mi saldo | Devoluciones recibidas y comprobantes | Retirar a mi banco |

**Desarrollador**

| Pantalla | Qué ve | Acción |
|---|---|---|
| Inicio | Proyectos, dinero protegido, pagos por recibir, acciones pendientes | — |
| Proyecto | Operaciones por unidad y documentos del proyecto, que se suben una vez y se reutilizan | Nueva operación |
| Nueva operación | La plantilla de preventa ya cargada | Completar comprador, unidad, importes, contrato y tercero; enviar invitación |
| Operación | Lo mismo que ve el comprador | Presentar documentos; recibir pago aprobado; responder una devolución |
| Mi saldo | Pagos recibidos y comprobantes | Retirar a mi banco |

**Tercero designado**

| Pantalla | Qué ve | Acción |
|---|---|---|
| Casos | Solo operaciones con desacuerdo o con devolución sin respuesta | Abrir caso |
| Caso | Acuerdo, documentos, motivos de cada parte y la propuesta de reparto | Firmar o ejecutar |

**Vista de verificación**

Dentro de cada operación, separada del recorrido normal. Muestra el contrato en la red, los roles, el saldo leído de la red, las huellas, el activo de prueba, todos los comprobantes y la función "Probar protección". Es para el jurado y para auditoría.

### 5.5 Reglas de pantalla

- Cada pantalla responde tres preguntas: qué pasó, qué sigue y a quién le toca.
- Siempre se distinguen tres importes: protegido, entregado al desarrollador y devuelto.
- Nada se muestra como hecho hasta estar confirmado en la red. Mientras tanto se lee "Confirmando".
- Cuando el comprador confirma una condición, lee "Listo. El desarrollador ya puede recibir el pago" y no le queda ninguna acción.
- Una devolución pedida nunca se presenta como ejecutada.
- Los errores se explican en lenguaje llano y dicen qué hacer.
- El envío de XLM para comisiones de red ocurre solo, sin que el usuario lo vea.
- Pollar muestra por defecto su propia ventana de confirmación en cada firma. Si se puede desactivar o adaptar se comprueba en S7. [Por probar]

---

## 6. Flujos

| Flujo | Paso | Quién firma | Llamada |
|---|---|---|---|
| Acuerdo | Crear operación y subir contrato | — | Solo base de datos |
| | Enviar al comprador | Desarrollador | `signMessage` |
| | Aceptar | Comprador | `signMessage` |
| | Desplegar escrow | Plataforma | `/deployer/multi-release` |
| Depósito | Pagar en la pasarela | Proveedor simulado | `/escrow/multi-release/fund-escrow` |
| Liberación | Presentar evidencia | Desarrollador | `change-milestone-status` |
| | Confirmar | Comprador | `approve-milestone` |
| | Cobrar | Desarrollador | `release-milestone-funds` |
| Objeción | Objetar con motivo | — | Solo base de datos |
| Devolución | Pedir devolución, plazo vencido | Comprador | `dispute-milestone` |
| | Aceptar o rechazar con motivo | Desarrollador | Solo base de datos |
| | Ejecutar | Tercero designado | `resolve-milestone-dispute` |
| Desacuerdo | Abrir | Comprador o desarrollador | `dispute-milestone` |
| | Ejecutar el reparto | Tercero designado | `resolve-milestone-dispute` |
| Prueba de protección | Intentar cobrar sin confirmación | Cada parte | Llamada directa al contrato |

Todas las firmas de usuario son con `signTx` de Pollar sobre la propia billetera (origen = quien firma); la plataforma firma con su llave solo el despliegue, y el proveedor simulado el depósito. Si Pollar acepta firmar una transacción que va a fallar (la prueba de protección) está por probar.

El contrato permite aprobar sin evidencia. El orden lo impone la app.

---

## 7. Fase 0 — Pruebas con llaves

Bloqueada hasta tener las llaves. S1 a S5, S9 y S10 las corro yo con la llave de Trustless Work y llaves locales. S6 a S8 necesitan a una persona del equipo para iniciar sesión en Pollar.

Orden: S7 y S8 van primero, porque deciden si la devolución acordada funciona como promete la propuesta.

| Prueba | Pasa si | Si falla |
|---|---|---|
| S1 Desplegar un escrow con `TRAMOUSD` y otro con USDC de Circle | Ambos devuelven `contractId` | Se usa el que despliegue |
| S2 Leer el escrow e inspeccionar la transacción | Quedan anotados: escala de `platformFee`, cuenta de origen, vencimiento, estado inicial del tramo | — |
| S3 Depositar con la cuenta del proveedor | El saldo leído de la red coincide | Transferencia directa al contrato |
| S4 Evidencia, confirmación y liberación, con ambos activos | Queda anotado cuánto recibe cada cuenta, al centavo | Si `TRAMOUSD` no libera, se usa Circle |
| S5 Desacuerdo y resolución con la cuenta 2 de 3, llaves locales | Se ejecuta con dos firmas; queda anotado cuánto recibe el comprador | Enviar por Soroban RPC en vez de por la API |
| S6 Firma diferida: una firma, se reinicia el servicio, la segunda llega después | Se ejecuta, o la app detecta que caducó, rearma y vuelve a pedir firmas | La cuenta 2 de 3 no se usa |
| S7 Pollar: ingreso, verificación en backend, `signTx`, `signMessage`, línea de confianza, ventana de confirmación | Todo responde; queda anotado si la ventana de confirmación se puede desactivar o adaptar | SEP-10 para la sesión; si la ventana es fija, se ajustan los textos previos a cada firma |
| S8 Pollar firma la resolución: ruta A, y si no, ruta B | Una de las dos devuelve una firma válida | El tercero es el único resolutor |
| S9 Intento inválido contra el contrato de Trustless Work | Queda como transacción fallida en el explorador | Mostrar el rechazo de la simulación |
| S10 Permisos negativos | Todos los intentos de la lista son rechazados | Se corrige antes de seguir |

Lista de S10:

- El comprador intenta liberar un tramo.
- El desarrollador intenta aprobar un tramo.
- El desarrollador intenta cobrar un tramo sin aprobar.
- Una cuenta ajena intenta aprobar, liberar y resolver.
- El resolutor intenta mover un tramo sin desacuerdo abierto.
- La plataforma intenta cambiar roles o destinatarios con fondos depositados.

La fase 0 termina con cuatro cosas escritas: activo elegido, ruta de firma elegida, tabla de importes reales y resultado de cada prueba.

**Cierre de la fase 0 (17 nov):**

1. **Activo:** USDC de Circle, obtenido en el pool de Testnet sin faucet.
2. **Ruta de firma:** el tercero designado como único resolutor (S8: Pollar solo firma a nombre de la propia billetera). Aceptado por el equipo el 17 nov; el contrato propio de 3.1 queda como mejora si da el tiempo.
3. **Importes reales:** 98,8 % al destinatario, 0,9 % a la plataforma y 0,3 % a Trustless Work, en liberaciones y devoluciones. De 6.000: 5.928 / 54 / 18.
4. **Pruebas:** S1 a S10 corridas; el detalle está en 2.1 y en `data/fase0-state.json`.

Para la app quedan cuatro hallazgos de Pollar: la plataforma debe enviar XLM antes de la línea de confianza; Pollar muestra su ventana de confirmación en inglés en cada `signTx`; SEP-53 firma sin ventana; el backend valida el token con `/v3/tokens/verify`.

---

## 8. Fase 1 — Qué hay que construir

**Punto de partida.** El servidor (`server/`) es del modelo anterior: multifirma nativa y contraseñas con llaves cifradas. No tiene Trustless Work ni Pollar. La web (`src/`) está vacía. Hay una sola maqueta (`diseno/maquetas/compra.html`). Lo que sirve de la fase 0: `scripts/spikes/fase0.ts` (llamadas a Trustless Work y al contrato, compra de USDC en el pool) y `scripts/spikes/pollar-server.ts` (verificación del token, firma con Pollar y envío).

**Terminado de la fase 1:** la secuencia de la sección 1 se hace entera desde la interfaz, con tres cuentas Pollar (comprador, desarrollador y tercero) en tres navegadores, y cada monto en pantalla coincide al centavo con el explorador.

Los bloques van en orden de dependencias. Dentro de cada bloque, las tareas que no dependen entre sí se pueden hacer a la vez. El bloque C (diseño) puede avanzar en paralelo con el B.

### A. Base del proyecto

1. Iniciar el repositorio git. `.env` y `data/` ya están excluidos en `.gitignore` (tienen llaves).
2. Renombrar los restos de "Tramo": `package.json`, `<title>` de `index.html`, cookie `tramo_session`, prefijo de código `TR-`, entradas `tramo.*` y el nombre del archivo de base `tramo.db`.
3. Borrar lo que ya no aplica: `shared/crypto.ts`, el escrow por cuenta propia de `server/stellar.ts` (`createEscrow`, `buildEscrowTx`, pago al escrow), la tabla `pending_txs` y el registro con contraseña.
4. `package.json`: quitar o crear `scripts/e2e.ts` y `scripts/seed.ts`. No se cargan datos escritos en el código (regla 2 de la sección 1).

*Terminado:* `npm run dev` arranca sin errores y `npm run typecheck` pasa limpio.

### B. Servidor

1. **Configuración** (`server/config.ts`): llave y URL de Trustless Work, llave secreta de Pollar, emisor del USDC de Circle, Horizon, Soroban RPC y un segundo RPC de respaldo.
2. **Cuentas de servicio** (`server/stellar.ts`):
   - Tres cuentas: plataforma (despliega y recibe la comisión), proveedor simulado (deposita) y fondeador (envía XLM a los usuarios).
   - Al arrancar: friendbot si no existen, línea de confianza al USDC de Circle, y si el proveedor tiene poco USDC lo compra en el pool de Testnet (como C0).
   - Lectura de saldos del contrato del activo y confirmación de transacciones en la red.
3. **Acceso con Pollar** (`server/pollar.ts`): `POST /api/auth/pollar { token }` → `/v3/tokens/verify` → sesión por cookie. El usuario se identifica por su id de Pollar y la dirección de su billetera.
4. **Cliente de Trustless Work** (`server/tw.ts`):
   - Llamadas: desplegar, depositar, cambiar el estado del tramo, aprobar, liberar, abrir desacuerdo, resolver y enviar transacción.
   - Una llamada cada ~1,2 s, con reintento si responde 429.
   - Lectura del escrow desde el contrato (`get_escrow` simulado), no solo desde la API, para 4.8.
5. **Armar, firmar y enviar** (patrón único para toda firma de usuario):
   - `POST /api/acciones`: el servidor comprueba rol y estado, arma la transacción con Trustless Work y la guarda como "armada", con su hash.
   - El navegador la firma con Pollar.
   - `POST /api/acciones/:id/enviar { signedXdr }`: el servidor comprueba que es la misma transacción que armó y que la firma corresponde a quien la pide. La envía, espera la confirmación en la red y recién ahí cambia el estado.
   - Si venció (~100 s), responde que hay que rearmar.
6. **Base de datos** (`server/db.ts`):
   - `users` con id de Pollar, billetera, tipo de cuenta, perfil y estado de activación (XLM enviado, USDC habilitado).
   - `operations` con el id del contrato del escrow.
   - Estados de los tramos alineados con Trustless Work.
   - `chain_txs` como registro de 4.8, en lugar de `pending_txs`.
   - Respuestas del desarrollador a una devolución (acepta o rechaza, motivo y plazo).
7. **Reglas** (`server/domain.ts`):
   - Estados y "qué sigue, a quién le toca" para los tres roles, con el tercero como resolutor.
   - Los tres importes (protegido, entregado y devuelto) leídos de la red.
   - Reconciliación al arrancar y al abrir una operación (4.8).
   - Permisos por rol (4.9).
8. **Rutas** (`server/app.ts`):
   - Activación de la cuenta: XLM y estado del USDC.
   - Proyectos y sus documentos.
   - Operación nueva con la plantilla (5.3); envío con firma SEP-53 del desarrollador; invitación; aceptación con firma SEP-53 del comprador y despliegue del escrow.
   - Orden de pago y pasarela de pruebas → depósito.
   - Tramos: evidencia, confirmar, objetar, recibir pago aprobado, pedir devolución, responder devolución, abrir desacuerdo.
   - Tercero: casos y resolución con reparto.
   - Saldo y retiro a banco.
   - Avisos en vivo (ya escritos).
   - Vista de verificación con la prueba de protección.

*Terminado:* un script recorre la secuencia de la sección 1 contra el servidor, con llaves locales (ver E.1), y los saldos en la red coinciden.

### C. Diseño

1. `DESIGN.md` y los tokens a partir de la dirección "Plano de ventas" (`diseno/maquetas/compra.html`): colores, Sofia Sans con cifras tabulares y estados con convención de dibujo. `index.html` carga hoy Figtree y Fraunces: hay que corregirlo.
2. Componentes propios:
   - Corte del edificio con la unidad del comprador.
   - Barra de tramos.
   - Los tres importes.
   - Estado "Confirmando".
   - Comprobante con "Ver en el registro público".
   - Botón de acción única fijo abajo.
   - Explicación previa a cada firma, en español, porque la ventana de Pollar está en inglés.
3. Maquetas que faltan antes de construir sus pantallas: invitación, acuerdo, pago, revisar documentos, pedir devolución, inicio del desarrollador, nueva operación, caso del tercero e inicio de sesión propio.

*Terminado:* cada pantalla de 5.4 tiene su maqueta aprobada por el equipo.

### D. Web (`src/`)

1. **Base:** router, `PollarProvider`, cliente de la API (`@tanstack/react-query`), sesión y avisos en vivo.
2. **Componente de firma**, uno solo para toda la app:
   - Muestra qué se confirma.
   - Arma, llama a `signTx(xdr, { skipSponsorship: true })` y envía.
   - Maneja el vencimiento, el rechazo en la ventana de Pollar y los errores de red, explicados en lenguaje llano (5.5).
   - Muestra "Confirmando" hasta que responde la red.
3. **Primer ingreso:** tipo de cuenta, perfil y "Activar tu cuenta" (XLM más USDC, un solo paso).
4. **Recorrido del acuerdo y el depósito:** proyecto, nueva operación, invitación, acuerdo, pago, pasarela de pruebas (estilo propio, rotulada) y "Mi operación".
5. **Recorrido de la liberación:** presentar documentos, revisar con guías, confirmar u objetar, recibir pago aprobado.
6. **Recorrido de la devolución y el desacuerdo:** plazo vencido, pedir devolución, respuesta del desarrollador, casos del tercero y ejecución del reparto.
7. **Mi saldo** con comprobantes y retiro a banco, para el comprador y el desarrollador.
8. **Vista de verificación:** contrato, roles, saldo leído de la red, huellas, activo de prueba, comprobantes y "Probar protección".

*Terminado:* el criterio de la fase 1, arriba.

### E. Pruebas, despliegue y demo

1. **Prueba automática del flujo** (`scripts/e2e.ts`): usa llaves locales en lugar de Pollar, mediante un acceso de prueba que solo existe si una variable de entorno lo activa y nunca en el sitio desplegado.
2. **Pendientes de Pollar por probar:**
   - Si firma una transacción que va a fallar (necesario para "Probar protección").
   - Si la ventana de confirmación se puede configurar (política `signConfirmation`).
3. **Despliegue:** HTTPS, disco persistente para SQLite y archivos, y el dominio agregado en Pollar (orígenes permitidos y direcciones de retorno).
4. **Demo:** guion de la sección 11 ensayado con tres cuentas; una persona ajena al equipo completa el recorrido del comprador sin ayuda; video de respaldo.

### Prioridad dentro de la fase 1

Si algo no entra, se recorta en este orden (lo último de la lista se corta primero):

1. A, B y D hasta el recorrido de la liberación.
2. Recorrido de la devolución y el tercero.
3. Vista de verificación y prueba de protección.
4. Inicio de sesión propio en español.
5. Avisos en vivo y operaciones de ejemplo creadas usando la app.

### Decisiones que la fase 1 necesita del equipo

| Decisión | Afecta a | Supuesto mientras no se decida |
|---|---|---|
| Comisiones en devoluciones (3.2) | Textos del acuerdo y de la devolución | Se muestra el neto (5.928 de 6.000) y se dice antes de aceptar el acuerdo |
| Evidencia del tramo 2 (5.3) | Plantilla de preventa | Acta de inicio de obra y fotografías fechadas del terreno |
| Plazo del desarrollador para responder una devolución | Reglas del tercero (4.3) | 72 horas; en la demo, minutos |
| Tres correos para la demo | Ensayos | — |

---

## 9. Prioridades

| Nivel | Funcionalidad |
|---|---|
| **P0** No se presenta sin esto | Acceso con Pollar |
| | Plantilla de preventa con los dos tramos y sus documentos (5.3) |
| | Recorrido del comprador y del desarrollador con vocabulario inmobiliario (5.2 y 5.4) |
| | Crear acuerdo y desplegar escrow |
| | Depositar fondos reales de Testnet |
| | Saldo verificable en Stellar |
| | Evidencia, confirmación y liberación |
| | Devolución mediante Trustless Work |
| | Enlaces al explorador en cada movimiento |
| | Estado confirmado en la red antes de mostrarse (4.8) |
| | Devolución y desacuerdo resueltos por el tercero designado |
| **P1** No debe frenar P0 | Inicio de sesión propio en español (4.5) |
| | Huella del contrato y firma del acuerdo |
| | Pasarela bancaria simulada completa |
| | Vista de verificación, con la prueba de protección y sus transacciones fallidas visibles |
| | Guías de revisión por documento |
| | Desacuerdo con reparto parcial |
| **P2** Al final, en forma simple | Avisos en vivo entre las dos pantallas |
| | Tres o cuatro operaciones de ejemplo creadas a mano |
| | Panel del tercero más allá de lo mínimo |
| | Reembolso de comisiones, si los importes medidos lo justifican |
| | Devolución acordada entre comprador y desarrollador sin el tercero: contrato propio como resolutor (3.1), sin probar |

Los avisos en vivo y las operaciones de ejemplo quedan al final del orden, pero no fuera: son lo que hace que la app no parezca una demo, y la parte de avisos ya está escrita.

Excluido: llaves propias con PIN.

---

## 10. Calendario

Supone entrega el 22 de noviembre. La final presencial publicada es el 27.

| Día | Trabajo | Al terminar el día |
|---|---|---|
| 17–18 | Fase 0 completa | Activo y ruta de firma elegidos; importes reales anotados |
| 19 | Acceso, acuerdo, escrow, depósito, saldo | Comprador y desarrollador usan la misma operación en dos navegadores |
| 20 | Liberación y devolución | La secuencia de la sección 1 corre completa en Testnet |
| 21 | P1, luego P2; prueba automática del flujo; video de respaldo | Tres ensayos de la demo con cronómetro; una persona ajena al equipo completa el recorrido del comprador sin ayuda |
| 22 | Despliegue, ensayo final, envío | Sin funcionalidades nuevas |

Regla de corte: si al final del 18 no se logró desplegar y liberar con Trustless Work, se elimina P2 y de P1 quedan solo la huella del contrato y la pasarela.

---

## 11. Guion de la demo

| Paso de la propuesta | Qué se ve |
|---|---|
| 01 Acuerdo | El desarrollador crea la operación; la compradora la acepta en otro navegador; aparece el escrow en el explorador |
| 02 Depósito | La compradora paga en la pasarela; el saldo en garantía aparece en las dos pantallas |
| 03 Intento de retiro | Desde la vista de verificación, cada parte usa "Probar protección"; dos transacciones fallidas en el explorador |
| 04 Confirmación | El desarrollador presenta los cuatro documentos del tramo 1; la compradora los confirma; el desarrollador pulsa "Recibir pago aprobado" |
| 05 Devolución | El tramo 2 vence; la compradora pide la devolución (el tramo queda congelado en la red); el desarrollador la acepta; el tercero designado la ejecuta en un tercer navegador; la compradora ve el dinero devuelto |
| 06 Consulta | Resumen: liberado, devuelto, retenido, con enlaces |

Para el paso 05 la fecha límite del tramo 2 se fija con hora, a pocos minutos del inicio. Monto devuelto medido en la fase 0: 5.928 de 6.000 (3.2), salvo que el equipo decida reintegrar las comisiones.

---

## 12. Lo que necesito de ustedes

1. ~~Llave de API de Trustless Work~~ y ~~llaves de Pollar~~: listas en `.env` (17 nov).
2. ~~USDC de prueba de Circle~~: resuelto sin faucet (C0 en 2.1).
3. ~~Iniciar sesión en Pollar para S7 y S8~~: hecho el 17 nov (página `scripts/spikes/pollar/index.html`, configuración `fase0-pollar`).
4. ~~Pregunta a los mentores de Trustless Work sobre otro activo~~: ya no bloquea; con USDC de Circle todo funciona por la API.
5. **Confirmar la fecha de entrega** (22 o 27 de noviembre).
6. **Definir la evidencia del tramo 2** (inicio de obra) y revisar las guías de cada documento de la plantilla (5.3).
7. ~~Qué hacer si Pollar no firma la cuenta de tres firmas~~: decidido el 17 nov, el tercero resuelve (3.1). Las otras opciones quedan para después, si da el tiempo (P2).

Las llaves van en un archivo `.env` local, no en el chat.

---

## 13. El código que ya existe

Está escrito y sin probar. Usa multifirma nativa en vez de Trustless Work, así que se adapta (detalle en la sección 8, bloques A y B):

| Archivo | Destino |
|---|---|
| `server/db.ts` | Se conserva; cambia la tabla de usuarios (identidad de Pollar), `pending_txs` se reemplaza por el registro de transacciones enviadas |
| `server/domain.ts` | Se conservan estados de tramos, historial y avisos en vivo; se quitan las solicitudes de firma compartidas |
| `server/app.ts` | Se conservan proyectos, archivos, avisos y pasarela; cambian sesión y firmas |
| `server/stellar.ts` | Se reduce a cuentas de servicio y activo; el escrow pasa a `server/tw.ts` |
| `shared/crypto.ts` | Se elimina |
| `scripts/spikes/soroban-multisig.ts` | Evidencia de la sección 2 |
| `scripts/spikes/fase0.ts` | Evidencia de la fase 0; base de `server/tw.ts` y de la compra de USDC |
| `scripts/spikes/pollar-server.ts` y `scripts/spikes/pollar/` | Evidencia de S7 y S8; base de `server/pollar.ts` y del componente de firma |

---

## 14. Riesgos abiertos

| Riesgo | Señal temprana | Respuesta |
|---|---|---|
| La versión del contrato en Testnet difiere del código leído | S2 y S4 dan resultados distintos a los esperados | Ajustar a lo observado; la red manda |
| Ninguna ruta de Pollar firma la resolución | **Ocurrió** (S8, 17 nov) | Tercero como único resolutor; ajustar paso 05, PRODUCT.md (posicionamiento) y pitch |
| Saldo insuficiente de USDC de Circle | El pool de Testnet se vacía o el friendbot limita | Comprar con anticipación; montos menores, mostrados tal cual |
| Pollar no firma la prueba de protección (transacción que va a fallar) | E.2 de la sección 8 | Mostrar el rechazo de la simulación (3.5) |
| Pollar cambia su SDK antes de la entrega | Falla tras actualizar | Versión fija, no actualizar |
| Límite de 50 llamadas por minuto en Trustless Work | Errores 429 | Guardar lecturas en la base; leer de la red al abrir una operación |
| Caída de Soroban RPC durante la demo | Respuestas lentas en los ensayos | Segundo proveedor de RPC configurado; video de respaldo |
