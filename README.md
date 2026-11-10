# Sistema de Gestión de Inventario

Aplicación web Full-Stack y **Progressive Web App (PWA) Offline-First** diseñada para digitalizar, controlar y agilizar de punta a punta el flujo operativo de inventario y pedidos: desde la toma de pedidos en calle con catálogo por marcas y descuentos personalizados, pasando por el picking físico y gestión de faltantes en depósito, hasta la preparación de datos estructurados para facturación y el control post-factura de despacho.

## ✨ Novedades recientes

* **Offline sin pérdida de trabajo:** autoguardado de la edición de borradores, cola idempotente de altas y `PUT`, persistencia del control post-factura y de los comentarios pendientes, y sincronización automática al reconectar.
* **Búsqueda más rápida:** índice multikey que combina código, nombre y marca (`"marca + producto"` funciona igual online y offline), caché de consultas y deltas incrementales del catálogo al volver a foco.
* **Repetir último pedido en un paso:** el resumen del último pedido por cliente se guarda localmente y se reutiliza sin red ni un segundo `fetch`.
* **Ergonomía móvil:** tarjetas compactas, checkout con miniaturas y edición de descuentos por línea, filtros `sticky`, renderizado diferido de listas largas, picking por marca, respuesta háptica y opción de mantener la pantalla despierta.
* **Avisos que no se pisan:** los banners flotantes se apilan por capas y se ocultan al abrir el teclado virtual.
* **Navegación continua:** la búsqueda y los filtros de las bandejas se conservan al abrir un pedido y volver; la barra móvil indica si hay un borrador activo.
* **Backoffice móvil:** los formularios de alta se pliegan para priorizar la búsqueda y la edición; la baja de marcas contempla los productos con baja lógica.
* **Endurecimiento de API:** rate limit por IP, timeouts en `fetch`, límites de consultas costosas, revocación de sesión en lecturas/SSE y sanitización de exportaciones CSV/XLSX.

---

## 🛠️ Tecnologías Utilizadas

| Categoría | Tecnologías |
| --- | --- |
| **Framework & UI** | **Next.js 16** (App Router, Server Components, Cache Components), **React 19**, **TypeScript 5**, **Tailwind CSS 4**, **Lucide React** |
| **Backend & Base de Datos** | **Node.js**, **MongoDB** (Local / Atlas), **Mongoose 9** (control de concurrencia optimista, índices compuestos y multikey), **Zod 4** |
| **Seguridad & Sesiones** | Cookies **httpOnly** firmadas con **HMAC SHA-256** (`__Host-sgi_session` en producción), **bcryptjs**, protección CSRF (`Origin` / `Sec-Fetch-Site`), CSP y cabeceras de seguridad |
| **PWA, Offline & Tiempo Real** | **Service Worker** versionado por build (`public/sw.js`), **IndexedDB** (catálogo offline y cola idempotente de pedidos), **Server-Sent Events (SSE)**, **Web Push Notifications** (`web-push` / VAPID) |
| **Archivos & Planillas** | **ExcelJS** (`exceljs`) para importación masiva de catálogo/clientes (`.xlsx` / `.csv`) y exportación de pedidos |
| **Observabilidad** | **Sentry** (`@sentry/nextjs`) con correlación `x-request-id`, métricas operativas, alertas como código y reporte de **Web Vitals** sin PII |
| **Testing & Performance** | **Node.js Test Runner** (`node:test`), **mongodb-memory-server**, **fake-indexeddb**, **Playwright** (`@playwright/test` + `@axe-core/playwright`), **Lighthouse 13** y presupuestos de bundle inicial |

---

## 🚀 Cómo Levantar y Probar la Demo Paso a Paso

### Requisitos previos

* **Node.js 20.9 o superior** (requerido por Next.js 16).
* **npm** (incluido con Node.js).
* Una instancia de **MongoDB** en ejecución: local (`mongodb://127.0.0.1:27017/sistema-gestion-inventario`) o [MongoDB Atlas](https://www.mongodb.com/atlas).

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar las variables de entorno

Copiá el archivo de ejemplo `.env.example` a `.env.local`:

```bash
cp .env.example .env.local
```

En PowerShell (Windows):

```powershell
Copy-Item .env.example .env.local
```

Contenido mínimo recomendado para `.env.local`:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/sistema-gestion-inventario
AUTH_SECRET=cambia-esto-por-un-secreto-largo-y-aleatorio-de-al-menos-16-caracteres
AUTH_SESSION_CACHE_TTL_SECONDS=45
SEED_ADMIN_PASSWORD=demo2026
```

<details>
<summary><strong>Ver tabla completa de variables de entorno</strong></summary>

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `MONGODB_URI` | Sí | Cadena de conexión a MongoDB. Ej. local: `mongodb://127.0.0.1:27017/sistema-gestion-inventario` o Atlas: `mongodb+srv://...`. |
| `AUTH_SECRET` | Sí | Secreto con el que se firma la cookie de sesión (HMAC SHA-256). Mínimo 16 caracteres. |
| `AUTH_SESSION_CACHE_TTL_SECONDS` | No | Vigencia (30–60 s) del caché que valida `active`, `sessionVersion` y rol en cada escritura. Por defecto `45`. |
| `TRUST_PROXY_HEADERS` | No | Confía en `x-forwarded-for` / `x-real-ip` para resolver la IP del rate limit. Sólo activarlo detrás de un proxy propio. Por defecto `false`. |
| `OFFLINE_CATALOG_MAX_PRODUCTS` | No | Tope de productos del snapshot offline. Por defecto `5000`. |
| `OFFLINE_CATALOG_MAX_CLIENTS` | No | Tope de clientes del snapshot offline. Por defecto `2000`. |
| `NEXT_PUBLIC_BUILD_ID` | No | Identificador que versiona las cachés del Service Worker. Si se omite se usa el SHA de CI o un id local. |
| `SEED_ADMIN_PASSWORD` | No | Contraseña del usuario `admin` creado por `npm run seed`. Por defecto `demo2026`. |
| `SEED_USERS` | No | Usuarios adicionales opcionales con formato `Nombre[rol]:contraseña` (`vendedor` o `controlador`). |
| `LOG_LEVEL` | No | Nivel de logging estructurado: `info` (por defecto), `warn`, `error` o `silent`. |
| `VAPID_PUBLIC_KEY` | No | Clave pública VAPID para Web Push. Sin las tres variables VAPID el envío push queda deshabilitado. |
| `VAPID_PRIVATE_KEY` | No | Clave privada VAPID (nunca sale del servidor). |
| `VAPID_SUBJECT` | No | Contacto del emisor VAPID (`mailto:...` o `https://...`). |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | No | DSN de Sentry para servidor y navegador. Sin DSN Sentry queda deshabilitado (no-op). |
| `SENTRY_ENVIRONMENT` | No | Entorno reportado a Sentry (`development`, `staging`, `production`). |
| `SENTRY_TRACES_SAMPLE_RATE` | No | Muestreo de traces de performance (0–1, por defecto `0.1`). |

</details>

### 3. Poblar la base de datos con información ficticia (Seed)

Ejecutá el script de seed para cargar el entorno completo de demostración:

```bash
npm run seed
```

Si querés limpiar toda la base de datos y regenerar los datos de demostración desde cero:

```bash
npm run seed -- --reset
```

**¿Qué datos ficticios crea el seed?**
* **7 usuarios de demostración** cubriendo todos los roles operativos (`admin`, `vendedor`, `controlador`, `billing`).
* **6 marcas ficticias** (*NovaFarma*, *BioSalud*, *DermaPlus*, *VitaLab*, *AlbaCare* y *Línea General*).
* **40 productos** con códigos por marca, precios sin/con IVA (21 %) e índices de búsqueda normalizados.
* **15 clientes** (farmacias, droguerías, clínicas y perfumerías) con descuentos generales y descuentos especiales por marca.
* **12 pedidos** distribuidos en todos los estados del flujo (`borrador`, `paralizado`, `facturacion`, `control_post_factura` y `entregado`), con comentarios e historial.
* **8 notificaciones operativas** de muestra (bandejas de depósito, facturación y alertas privadas por vendedor).

#### 🔑 Credenciales de Usuarios de Demo

| Usuario | Contraseña | Rol | Permisos y qué probar en la demo |
| --- | --- | --- | --- |
| `admin` | `demo2026` | `admin` | Acceso total a todas las bandejas, métricas globales y **Backoffice** (`/backoffice/brands`, `/backoffice/products`, `/backoffice/clients`, `/backoffice/import`, `/backoffice/users`). |
| `vendedor` | `demo2026` | `vendedor` | Alta de pedidos (`/orders/new`), catálogo por marcas (`/catalog`), cartera de clientes (`/catalog/clients`), seguimiento de sus propios pedidos (`/orders`) y exportación/compartir por WhatsApp. |
| `ana.ventas` | `demo2026` | `vendedor` | Segunda cuenta de vendedora para comprobar el aislamiento de pedidos y notificaciones privadas entre vendedores. |
| `controlador` | `demo2026` | `controlador` | Bandeja de Depósito (`/deposit/orders`), picking físico línea por línea, ajuste de cantidades verificadas, agregado de productos en depósito, paralización por faltantes e impresión de hoja de control A4. |
| `luis.deposito` | `demo2026` | `controlador` | Segundo operador de depósito para probar concurrencia optimista y autosave de picking. |
| `facturacion` | `demo2026` | `billing` | Bandeja de Facturación (`/billing/orders`), vista de datos estructurados listos para facturar, control post-factura sobre duplicado y cierre a estado `entregado`. |
| `carla.facturacion` | `demo2026` | `billing` | Segunda cuenta de facturación y control de despacho. |

### 4. Levantar el servidor de desarrollo

```bash
npm run dev
```

Abrí [http://localhost:3000](http://localhost:3000) en el navegador e iniciá sesión con cualquiera de los usuarios de la tabla anterior.

---

## 🧪 Ejecución de Tests y Rendimiento

### 1. Suite de tests unitarios y de integración (`npm test`)

```bash
npm test
```

Ejecuta más de 80 suites con el runner nativo de Node (`tsx` + `node:test`), utilizando `mongodb-memory-server` y `fake-indexeddb` (no requiere tener MongoDB externo levantado). Cubre:
* Validaciones de esquemas, variables de entorno, timeouts, rate limit y respuestas de error sin filtraciones (`test-env.ts`, `test-validations.ts`, `test-api-hardening.ts`).
* Reglas de negocio de pedidos, descuentos generales/por marca, totales post-picking, snapshots, idempotencia y concurrencia optimista (`test-order-*.ts`, `test-discounts.ts`).
* Catálogo, bajas lógicas, importación masiva Excel y normalización de búsquedas sin `COLLSCAN`, incluida la búsqueda por marca (`test-catalog-*.ts`, `test-search-normalization.ts`).
* Administración de usuarios, sesiones, revocación inmediata, cabeceras de seguridad, protección CSRF y cookie `__Host-sgi_session` (`test-users-admin.ts`, `test-security.ts`).
* Cola offline en IndexedDB, autosave de borradores y picking, control post-factura, comentarios pendientes, catálogo offline, service worker y notificaciones SSE / Web Push (`test-offline-*.ts`, `test-order-draft.ts`, `test-post-control-queue.ts`, `test-pending-order-comment.ts`, `test-pwa-sw.ts`, `test-push-*.ts`, `test-sw-push.ts`).

### 2. Tests End-to-End con Playwright (`npm run test:e2e`)

```bash
npm run test:e2e:install   # una sola vez: instala Chromium y WebKit
npm run test:e2e
```

`npm run test:e2e` levanta automáticamente un MongoDB efímero en el puerto `27019`, siembra la base `sgi-e2e` y ejecuta las 23 specs en dos fases:
1. **Flujos generales** sobre el servidor de desarrollo (login, permisos por rol, alta de pedido, edición, duplicación, picking en depósito, paralización, facturación, control post-factura, entrega, impresión A4, compartir por WhatsApp, revocación de sesión, escrituras offline y accesibilidad con Axe).
2. **Suite PWA y Offline** sobre un build de producción para validar el Service Worker real, precache, arranque en frío sin red e hidratación desde IndexedDB.

### 3. Tests E2E exclusivos de PWA y modo Offline (`npm run test:e2e:pwa`)

```bash
npm run test:e2e:pwa
```

Compila la aplicación en modo producción y ejecuta únicamente las pruebas de Service Worker, caché de páginas permitidas (`/orders/new`, `/catalog`, `/catalog/clients`), catálogo offline en IndexedDB y limpieza segura al cerrar sesión (`e2e/pwa.spec.ts` y `e2e/offline-catalog.spec.ts`).

### 4. Suite de Rendimiento Móvil y Presupuestos (`npm run perf`)

```bash
npm run perf
```

Ejecuta el pipeline completo de rendimiento móvil contra los umbrales definidos en `performance-budgets.json`:
1. `npm run build` — Compilación de producción.
2. `npm run perf:bundle` — Verifica el tamaño de JS inicial (bytes y gzip) por ruta.
3. `npm run perf:playwright:run` — Mide LCP, INP, CLS, TBT y TTFB en móvil bajo throttling de CPU 4x y red Fast 3G.
4. `npm run perf:lighthouse` — Ejecuta auditorías de **Lighthouse 13** mobile y guarda los reportes en `.lighthouseci/`.

---

## 🔄 Flujo General de Estados del Pedido

```text
[Borrador] ──(Alerta a Depósito)──> [Verificación / Picking en Depósito]
                                              │
                                      (Si hay faltantes)
                                              │
                                              ▼
                                        [Paralizado] (Retomable)
                                              │
                                              ▼
[Facturación] <──(Alerta a Facturación)── [Verificado sin pendientes]
      │
      ▼
[Control Post-Factura (Duplicado)] ──> [Entregado]
```

| Rol | Pedidos | Depósito (Picking) | Facturación (Post-Factura) | Catálogo / Backoffice |
| --- | --- | --- | --- | --- |
| `admin` | Acceso total | Acceso total | Acceso total | Marcas, productos, clientes, importación Excel y usuarios |
| `vendedor` | Crea, edita borradores, duplica, comenta y archiva los suyos | — | — | Consulta de catálogo y clientes |
| `controlador` | Verifica ítems, agrega productos, paraliza y pasa a facturación | ✅ | — | — |
| `billing` | Comenta y archiva | — | Datos estructurados, control post-factura y entrega | — |

---

## 📚 Documentación Técnica y Funcional Adicional

1. 📄 **[Documento de Especificaciones Funcionales (DEF)](./documento-especificaciones-funcionales.md)** — Módulos operativos y reglas funcionales del negocio.
2. 🛠️ **[Documento de Especificaciones Técnicas (DET)](./documento-especificaciones-tecnicas.md)** — Arquitectura, modelo de datos en MongoDB y diseño de APIs.
3. 📅 **[Plan de Implementación y Breakdown de Features](./plan-implementacion.md)** — Hoja de ruta por fases e incrementos.
4. 🔐 **[Atomicidad y concurrencia en pedidos](./docs/atomicidad-pedidos.md)** — Control optimista de versiones (`version`) y efectos secundarios best-effort.
5. 🔔 **[Notificaciones por usuario y Web Push](./docs/notificaciones-por-usuario.md)** y **[Retención y limpieza TTL](./docs/notificaciones-retencion.md)**.
6. 📄 **[Paginación por cursor en pedidos](./docs/paginacion-por-cursor.md)** — Contrato `pagination=cursor` e índices compuestos.
7. 🛡️ **[Cabeceras de seguridad, CSRF y cookie `__Host-`](./docs/seguridad-cabeceras.md)**.
8. 🔁 **[Idempotencia del alta de pedidos y cola offline](./docs/idempotencia-alta-pedidos.md)**.
9. 📴 **[Caché PWA](./docs/pwa-cache.md)** y **[Catálogo offline en IndexedDB](./docs/catalogo-offline.md)**.
10. 🔎 **[Búsquedas escalables](./docs/busquedas-escalables.md)** y **[Caché de consultas de catálogo](./docs/cache-consultas-catalogo.md)**.
11. ⚡ **[Rendimiento de listas largas](./docs/rendimiento-listas-largas.md)**.
12. 📈 **[Observabilidad: Sentry, métricas y alertas](./docs/observabilidad.md)**.
13. 💾 **[Backup, restore y retención de MongoDB](./docs/backup-restore-mongo.md)**.
14. 📱 **[Rendimiento móvil y presupuestos de CI](./docs/rendimiento-movil.md)**.

---

## ✍️ Autor y Licencia

Desarrollado por **MaxiGP0 (Máximo Gómez Pessoa)**:

* 🐙 **GitHub:** [https://github.com/MaxiGP0](https://github.com/MaxiGP0)
* 💼 **LinkedIn:** [https://www.linkedin.com/in/maximo-gomez-pessoa/](https://www.linkedin.com/in/maximo-gomez-pessoa/)

Distribuido bajo la licencia **[MIT](./LICENSE)** © 2026 MaxiGP0.
