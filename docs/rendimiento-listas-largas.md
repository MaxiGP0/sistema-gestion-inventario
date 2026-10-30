# Listas largas y consumo en segundo plano

Este documento registra la medición y las decisiones del ítem **9 — Listas
largas y notificaciones con bajo consumo**. No se agregó ninguna librería de
virtualización.

## 1. Qué se cambió

### Render diferido con `content-visibility`

En `app/globals.css` se definieron clases utilitarias:

```css
.cv-list-item {
  content-visibility: auto;
  contain-intrinsic-size: auto var(--cv-size, 16rem);
}
```

Se aplican a:

| Componente | Clase | Alto estimado |
| --- | --- | --- |
| `OrderListCard` | `cv-list-item cv-order-card` | 17 rem |
| `ProductCardMobile` | `cv-list-item cv-product-card` | 13 rem |
| `ProductRowDesktop` | `cv-list-item cv-table-row` | 3.5 rem |
| Ítems de `NotificationsBell` | `cv-list-item cv-notification-item` | 5.5 rem |

El `auto` de `contain-intrinsic-size` hace que, después de la primera pintura,
el navegador recuerde el alto real de cada tarjeta. Así el scroll no salta
cuando el usuario sube o baja. Además `html` usa `scrollbar-gutter: stable`
para que la barra vertical no desplace el contenido al abrir bandejas o cambiar
la altura de una lista.

### Ventana de 200 tarjetas en las bandejas

`lib/order-list-window.ts` calcula qué parte del listado acumulado se renderiza:

* hasta 200 pedidos se muestran todos;
* al superar 200, se muestran las **últimas 200** tarjetas cargadas;
* las páginas anteriores siguen en memoria (no se vuelve a pedir al servidor),
  pero salen del DOM;
* "Cargar más" sigue anexando páginas de 50. Como la ventana mantiene un alto
  estable, el botón —que vive al final— conserva la posición del scroll en vez
  de saltar al principio;
* el pie muestra el rango visible (`Mostrando 301–500 de 500 pedidos · ventana
  de 200 tarjetas`).

La decisión surge de la medición: con 500 tarjetas reales en el DOM, la
acumulación de páginas producía long tasks de hasta **295 ms**; con la ventana
de 200 el máximo bajó a **106 ms** y el DOM quedó en 8.530 nodos tanto para 200
como para 500 pedidos cargados.

### Menos re-renders al buscar

* `OrderListCard` está memoizada (`memo`).
* Las bandejas pasan callbacks estables (`confirmArchiveOrder`,
  `confirmDeleteOrder`, `confirmDuplicateOrder`) que reciben el id del pedido;
  ya no se crea una arrow function nueva por tarjeta en cada render.
* `useOrderTray` usa `useDeferredValue` para la búsqueda: el input responde en
  el mismo tick y la consulta/lista se actualiza con el valor diferido. El
  cambio de archivados usa `startTransition`.

### Notificaciones en segundo plano

* `NotificationsBell` cierra el `EventSource` cuando `document.hidden` y lo
  reabre al volver a primer plano.
* Nunca consulta la bandeja con la pestaña oculta (guard en
  `fetchNotifications` y en los pollers).
* Con SSE sano, el polling de seguridad es de **60 s**.
* Si el SSE falla, el respaldo es de **10 s**.
* Al volver a primer plano se hace una puesta al día y se reabre el SSE. Si el
  servidor envió `connection-limit`, no se reintenta durante esa página.

## 2. Medición

Spec: `e2e/lists-performance.spec.ts` (Chromium desktop 1440×900, `next dev`,
sin throttling de CPU). Los pedidos se simulan interceptando `/api/orders` y se
cargan de a páginas de 50 con el botón real.

| Escenario | Antes | Después |
| --- | --- | --- |
| 200 cargados, tarjetas en DOM | 200 | 200 |
| 200 cargados, long task máxima | 141 ms | 121–135 ms |
| 500 cargados, tarjetas en DOM | 500 | **200** |
| 500 cargados, nodos del DOM | 21.130 | **8.530** |
| 500 cargados, long task máxima | 295 ms | **106–124 ms** |
| 300 cargados + tipeo en buscador | — | **93–101 ms** |
| Pestaña oculta 11,5 s (SSE caído) | — | **0 requests** |

Presupuesto usado en el spec: 200 ms por long task (`LONG_TASK_BUDGET_MS`), el
mismo orden que el límite de INP del plan de rendimiento.

El test también verifica:

* `content-visibility: auto` en las tarjetas renderizadas;
* `scrollbar-gutter: stable` y ausencia de overflow horizontal;
* que el scroll llega al final y no salta al pintar tarjetas fuera de pantalla;
* que tipear con 300 pedidos cargados no genera una long task mayor a 200 ms;
* que con la pestaña oculta no hay requests a `/api/users/notifications` ni
  reconexiones de `/api/events`, y que al volver a primer plano el SSE se
  reabre.

## 3. Cómo reproducir

```bash
npx playwright test e2e/lists-performance.spec.ts --project=chromium
```

El test adjunta `lists-200-500.json` y `typing-300-orders.json` al reporte de
Playwright con los números de cada corrida. Para el detalle de por qué se cierra
el SSE en segundo plano, ver
[`docs/sse-notificaciones.md`](./sse-notificaciones.md).
