# Documento de Especificaciones Técnicas (DET)
## Sistema de Gestión de Inventario (MongoDB Edition)

---

### 1. Resumen de Arquitectura y Visión General
El **Sistema de Gestión de Inventario** se diseñará bajo una arquitectura moderna, ligera, multiplataforma y de fácil despliegue, optimizada para ejecutarse tanto en dispositivos móviles (vendedores en la calle) como en computadoras de escritorio (depósito y facturación).

* **Tipo de Aplicación:** Aplicación Web Progresiva (PWA) / Aplicación Web Full-Stack (Next.js / Node.js).
* **Modelo de Datos:** Base de datos NoSQL orientada a documentos (**MongoDB**), permitiendo una estructura flexible y el almacenamiento embebido de ítems en los pedidos (*Orders*) para garantizar atomicidad y rendimiento óptimo en lecturas y consultas.
* **Seguridad:** Autenticación basada en token/sesión con contraseña privada cifrada o accesos controlados por credenciales.

---

### 2. Stack Tecnológico Principal
Para garantizar rendimiento, mantenibilidad, soporte PWA offline/online y carga fluida de archivos Excel con MongoDB, se define el siguiente stack recomendado:

* **Frontend:**
  * **Framework:** Next.js (React) con TypeScript.
  * **Estilos & UI:** Tailwind CSS (diseño responsivo adaptado a dispositivos móviles y escritorio).
  * **PWA (Progressive Web App):** Service Workers y Web Manifest habilitados para funcionamiento fluido en móviles y soporte de notificaciones Push.
  * **Lector de Archivos:** `exceljs` para procesar la importación masiva de catálogos y precios en Excel.
* **Backend:**
  * **Runtime / Framework:** Next.js API Routes / App Router (Node.js) con **Mongoose** como ODM para modelado y validación de esquemas en MongoDB.
* **Base de Datos:**
  * **SGBD:** **MongoDB Atlas** (Cloud) o MongoDB local (Docker / servidor de red interna de la distribuidora).
* **Sistema de Notificaciones:**
  * Alertas en tiempo real mediante **WebSockets (`Socket.io`)** o **Server-Sent Events (SSE)** para notificar instantáneamente el ingreso de nuevos borradores a depósito o estructuras listas a facturación.
  * Estado leído por usuario en `NotificationRead` (una fila por usuario y
    notificación) y preferencia `notificationsEnabled`.
  * **Web Push Notifications** para dispositivos móviles: planificado para la
    **fase 2** (VAPID, suscripciones por dispositivo y evento `push` del service
    worker). Ver `docs/notificaciones-por-usuario.md`.

---

### 3. Modelo de Datos (Esquema de Documentos en MongoDB)

#### 3.1. Colección `users` (Usuarios / Autenticación)
* `_id` (ObjectId)
* `username` (String, único)
* `password_hash` (String: contraseña privada cifrada con bcrypt)
* `notifications_enabled` (Boolean: activar/desactivar notificaciones)
* `createdAt` (Timestamp)

#### 3.2. Colección `clients` (Clientes)
* `_id` (ObjectId)
* `code` (String, único: código de cliente)
* `name` (String: nombre o razón social)
* `address` (String: dirección)
* `general_discount` (Number: porcentaje de descuento general, ej: 5.00)
* `brand_discounts` (Array de objetos embebidos: `[{ brandId: ObjectId, discountPercentage: Number }]`)
* **Búsqueda:** `GET /api/clients` filtra con regex case-insensitive (coincidencia parcial, para el autocompletado) sobre `code`, `name`, `localidad`, `province` y `address`, y ordena por `name`. Es una única vía de búsqueda, igual que la de productos y pedidos. No se declara índice de búsqueda porque un regex no anclado no puede usar índices B-tree; el compuesto `{ name: 'text', ... }` que existía sólo lo habría usado una consulta `$text` que no se realiza. Si se migra a `$text`, crear un índice de texto puro y actualizar el endpoint.

#### 3.3. Colección `brands` (Marcas)
* `_id` (ObjectId)
* `name` (String, único: ej: Capitalis, Genomma, Algabó, Bagó)
* `code_prefix` (String o Null: prefijo característico del código, ej: "C", "B")

#### 3.4. Colección `products` (Productos)
* `_id` (ObjectId)
* `brandId` (ObjectId, referencia a `brands`)
* `code` (String: código del producto dentro de su marca)
* `name` (String: nombre del producto)
* `imageUrl` (String: URL o ruta de la imagen)
* `price` (Number: precio unitario actualizable de catálogo)
* **Índices recomendados:** Índice compuesto único en `{ brandId: 1, code: 1 }`.

#### 3.5. Colección `orders` (Pedidos con Ítems Embebidos)
* `_id` (ObjectId)
* `clientId` (ObjectId, referencia a `clients`)
* `status` (String: `borrador`, `paralizado`, `facturacion`, `control_post_factura`, `entregado`)
* `items`: Array de subdocumentos (Ítems del pedido):
  * `productId` (ObjectId, referencia a `products`)
  * `unitPrice` (Number: **Snapshot del precio unitario** al momento de crear/modificar el pedido, protegiendo el histórico ante actualizaciones de catálogo)
  * `requestedQuantity` (Number: cantidad inicial pedida por el vendedor)
  * `verifiedQuantity` (Number: cantidad confirmada por depósito)
  * `isPending` (Boolean: indica si el ítem quedó pendiente / backorder)
  * `itemDiscount` (Number: descuento aplicado al ítem)
  * `lineTotal` (Number: subtotal calculado de la línea)
* `subtotal` (Number: suma antes de descuentos)
* `totalDiscount` (Number: monto total descontado)
* `finalTotal` (Number: monto final del pedido)
* `createdBy` (String o ObjectId del usuario creador)
* `createdAt` (Timestamp)
* `updatedAt` (Timestamp)

---

### 4. Especificación de Módulos Técnicos

#### 4.1. Módulo de Seguridad y Autenticación
* Endpoint de Login (`POST /api/auth/login`).
* Verificación de la contraseña privada de acceso contra el hash en MongoDB.
* Almacenamiento de sesión segura (JWT o Cookies HTTP-Only).
* Bandeja del usuario (`GET /api/users/notifications`) con estado leído
  individual (`NotificationRead`).
* Conmutador de preferencias de notificaciones (`PUT /api/users/notifications`) para activar/desactivar alertas; la pantalla vive en `/settings/notifications`.

#### 4.2. Módulo de Importación Masiva (Excel)
* Endpoint de carga (`POST /api/catalog/import`):
  * Recibe un archivo `.xlsx` o `.csv`.
  * Valida las columnas (Código, Nombre, Marca, Precio, Imagen).
  * Realiza operaciones *BulkWrite / Upsert* en MongoDB (actualiza precios si el producto existe por `brandId` + `code`, o lo crea si es nuevo).
  * No altera el `unitPrice` almacenado en las órdenes existentes en la colección `orders`.

#### 4.3. Módulo de Pedidos y Búsqueda Jerárquica
* Consultas optimizadas en MongoDB con agregaciones o filtros en `products` bajo la estructura: `brandId -> (name o code)`.
* Cálculo dinámico y almacenamiento con snapshot de precios en el documento del pedido (`orders`).

#### 4.4. Módulo de Estados y Ítems Pendientes (Paralizados)
* Transiciones controladas mediante Mongoose en la colección `orders`:
  * `borrador` (alta del vendedor; notifica a depósito).
  * Si hay faltantes críticos: estado `paralizado` (el pedido queda retenido esperando stock futuro, permitiendo modificaciones futuras en los ítems embebidos).
  * `borrador` / `paralizado` ➔ `facturacion` (Notifica al facturista con los datos estructurados listos).
  * `facturacion` ➔ `control_post_factura` ➔ `entregado`.

---

### 5. Consideraciones de Despliegue e Infraestructura
* **MongoDB Atlas o Servidor Local:** Conexión flexible a MongoDB Atlas para acceso Cloud seguro desde dispositivos móviles (vendedores) y PC (depósito/facturación), o bien base de datos desplegada en contenedor Docker dentro de la red local de la distribuidora.
* **Respaldo de Datos:** Respaldos programados automáticos mediante `mongodump` / instantáneas en MongoDB Atlas.