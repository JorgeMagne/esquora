---
name: "ESQUORA"
description: "Plano de ventas para operaciones de preventa con dinero protegido."
colors:
  papel: "#F4F5F2"
  papel-secundario: "#E8EDF0"
  tinta: "#19232D"
  texto-secundario: "#4D5C69"
  linea: "#D2DBE1"
  linea-control: "#718292"
  cobalto: "#3067CC"
  cobalto-activo: "#234FA3"
  cobalto-claro: "#E4EDFC"
  texto-sobre-tinta: "#C4D0DA"
  foco-sobre-tinta: "#A6C6FF"
  tinta-activa: "#2A3D51"
  blanco: "#FFFFFF"
  error: "#892837"
  papel-error: "#FAEBEC"
  banco: "#263D54"
  papel-banco: "#EAF0F5"
typography:
  display:
    fontFamily: "Sofia Sans, system-ui, sans-serif"
    fontSize: "4.5rem"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-.03em"
  headline:
    fontFamily: "Sofia Sans, system-ui, sans-serif"
    fontSize: "2.55rem"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-.028em"
  title:
    fontFamily: "Sofia Sans, system-ui, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-.019em"
  body:
    fontFamily: "Sofia Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Sofia Sans, system-ui, sans-serif"
    fontSize: ".94rem"
    fontWeight: 700
rounded:
  recto: "0px"
  avatar: "50%"
spacing:
  margen-movil: "20px"
  margen-escritorio: "36px"
  grupo: "14px"
  seccion: "28px"
components:
  boton-principal:
    backgroundColor: "{colors.tinta}"
    textColor: "{colors.papel}"
    rounded: "{rounded.recto}"
    height: "48px"
    padding: "11px 16px"
  boton-principal-hover:
    backgroundColor: "{colors.tinta-activa}"
  boton-secundario:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.tinta}"
    borderColor: "{colors.tinta}"
    rounded: "{rounded.recto}"
    height: "48px"
    padding: "11px 16px"
  campo:
    backgroundColor: "{colors.papel}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.recto}"
    height: "48px"
    padding: "10px 11px"
  barra-de-condiciones:
    height: "12px"
  navegacion-inferior:
    backgroundColor: "{colors.papel}"
    height: "60px"
---

# Sistema de diseño de ESQUORA

## Overview

**Plano de ventas.** La unidad del comprador vive en un corte esquemático del edificio. El dibujo y la condición actual explican el estado de la preventa antes de que el comprador lea el expediente.

La aplicación se lee como un plano en papel claro. Una línea fina separa cada grupo, la tinta oscura gobierna la lectura y las acciones, y el cobalto señala el dinero que sigue protegido. La maqueta aprobada define la composición móvil de «Mi compra». La web extiende sus reglas a proyectos, acuerdos, casos y comprobantes. [Maqueta aprobada](diseno/maquetas/compra.html) · [Estilos](src/styles.css)

## Colors

- **Papel y tinta.** El contenido usa papel claro. El encabezado usa tinta oscura con el logotipo en blanco cálido y la Q a 30°. El favicon toma el símbolo a un color sobre el mismo fondo. [Logotipo](public/esquora-logo.svg) · [Favicon](public/favicon.svg)
- **Cobalto.** Marca la unidad en el plano, el dinero protegido, los enlaces y el foco por teclado sobre papel. Los controles del encabezado usan azul claro para el foco y la selección sobre tinta.
- **Estados.** Azul sólido para lo protegido, tinta sólida para lo entregado, rayado para lo devuelto y línea discontinua para lo pendiente de depósito. Cada estado también se escribe.
- **Pasarela.** Papel gris azulado y acciones en tinta. El rótulo de prueba permanece visible en la página de pago.

## Typography

Sofia Sans aporta carácter al título, los controles y las cifras. La fuente variable se sirve localmente en pesos de 400 a 700. Los importes usan cifras tabulares y se localizan en español de Bolivia. La cantidad protegida domina «Mi compra». Su tamaño es de 4,5 rem en escritorio y 3,18 rem en teléfonos de hasta 425 px. Las direcciones y huellas se muestran en fuente monoespaciada solo en verificación. [Licencia de Sofia Sans](public/fonts/sofia-sans-OFL.txt)

## Layout

- En teléfonos, el encabezado mide 56 px y el plano de la unidad ocupa 116 × 230 px junto al importe. El pie de navegación mide 60 px más el área segura. La acción contextual aparece fija encima del pie.
- En pantallas de más de 760 px, la navegación pasa arriba. Los formularios y expedientes que tienen dos grupos se muestran en columnas. «Mi compra» conserva el corte del edificio a la derecha.
- El ancho máximo es 1.216 px para el marco y 970 px para «Mi compra». Desde 992 px, el margen exterior es de 36 px.

## Elevation & Depth

La profundidad proviene de la jerarquía tipográfica, los bordes y el contraste entre superficies. Los diálogos de confirmación se separan con un velo oscuro mientras concentran el foco.

## Shapes

Contornos rectos, controles cuadrados y líneas delgadas. El avatar circular distingue el acceso a la cuenta. El corte de la torre se dibuja con vectores geométricos y señala la unidad en cobalto.

## Components

- **Acción principal.** Botón en el mismo tono de tinta que el fondo del logotipo, con etiqueta de verbo, flecha y 48 px de altura mínima. En el pie contextual mide 54 px. El estado ocupado conserva el texto de la acción y anuncia el progreso. Las acciones secundarias usan borde y texto en tinta sobre papel.
- **Campo.** Borde visible, etiqueta persistente y al menos 48 px de altura. Se indica el horario de Bolivia en los plazos y se admiten centavos.
- **Condiciones.** La barra representa el importe relativo de cada condición. La lista permite abrir cada expediente y muestra su estado y monto. En un tramo entregado o devuelto, la fila muestra el importe neto registrado. Si hubo un reparto, se muestran ambos importes netos.
- **Corte de torre.** La silueta y el marcador azul se mantienen estables. Con la documentación confirmada, se consolida la base del plano. Al confirmarse el inicio, se consolidan la cuadrícula y las divisiones. Una devolución mantiene el nivel anterior. La posición del marcador es esquemática.
- **Plano de protección.** La caja fuerte ocupa el centro de una perspectiva con edificios y trazos de replanteo detrás. Se usa como ilustración en la pasarela. El contorno se traza una vez y se muestra completo con movimiento reducido.
- **Pago.** «Mi compra» lleva a la cotización mediante una sola acción. La pasarela destaca el total en bolivianos y el importe protegido en dólares, con tipo de cambio y vencimiento. La espera conserva la referencia. El comprobante muestra el importe depositado y el enlace a la transacción después de confirmarse en la red.
- **Comprobantes.** Cada movimiento confirmado tiene fecha y acceso al registro público. La demostración de protección distingue una simulación de un intento registrado en Stellar.

## Do's and Don'ts

- Conserva una sola acción principal para la tarea actual y una zona clara para leer el estado antes de actuar.
- Usa etiquetas para distinguir los importes protegido, entregado y devuelto, incluso cuando alguno sea cero.
- En «Mi compra», el importe protegido ocupa la cabecera. El resumen inferior muestra lo entregado y lo devuelto.
- Muestra «Confirmando» mientras el pago, la devolución o el registro del acuerdo esperan a la red.
- Reserva los detalles de Stellar para la vista de verificación. Los usuarios ven la condición, la persona que debe actuar y el comprobante.
- Mantén visibles el foco por teclado y la alternativa de movimiento reducido.
