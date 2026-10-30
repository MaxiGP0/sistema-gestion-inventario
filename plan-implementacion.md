# Plan de Implementación y Breakdown de Features
## Sistema de Gestión de Inventario (MongoDB Edition)

---

### 1. Resumen de la Metodología
El desarrollo de la aplicación se dividirá en **Fases e Incrementos** lógicos. Cada fase se centra en construir valor funcional de manera progresiva, permitiendo realizar pruebas y ajustes tempranos antes de pasar al siguiente módulo operativo.

---

### Phase 1: Fundamentos, Base de Datos y Autenticación (Sprint 1)
*Objetivo: Establecer el entorno técnico base, la seguridad y la gestión de datos maestros con MongoDB.*

* **F1.1. Configuración del Entorno y Estructura Base:**
  * Inicialización del repositorio (Next.js + TypeScript + Tailwind CSS).
  * Configuración de la conexión a **MongoDB** mediante **Mongoose**.
* **F1.2. Módulo de Seguridad:**
  * Creación del modelo `User` y sistema de autenticación por **contraseña privada** con bcrypt.
  * Pantalla de Login, gestión de sesiones (JWT/Cookies) y protección de rutas.
* **F1.3. Modelos de Datos Iniciales (MongoDB / Mongoose):**
  * Creación de esquemas para `Client` (con descuentos generales y por marca), `Brand` y `Product` (con índice único compuesto `brandId` + `code`).
* **F1.4. Módulo de Importación y Backoffice (Catálogo):**
  * Interfaz para la carga manual y masiva de datos mediante archivos **Excel (`.xlsx` / `.csv`)** usando ExcelJS.
  * Lógica de parseo y actualización masiva (*BulkWrite / Upsert*) de precios y productos.

---

### Phase 2: Módulo de Creación de Pedidos (Sprint 2)
*Objetivo: Permitir a los vendedores armar pedidos en calle de forma ágil y estructurada.*

* **F2.1. Selector de Clientes y Descuentos:**
  * Buscador rápido de clientes por nombre, dirección o código.
  * Asignación y visualización de **descuentos generales y por marca**.
* **F2.2. Interfaz de Catálogo por Marcas (Planilla):**
  * Visualización de productos agrupados por marcas.
  * Implementación de la **búsqueda jerárquica (`Marca -> Nombre o Código`)**.
  * Visualización de imágenes de productos y precios actualizados.
* **F2.3. Gestión del Carrito / Pedido Inicial:**
  * Inserción de cantidades en formato planilla.
  * Creación del esquema `Order` con ítems embebidos y **snapshot de `unitPrice`**.
  * Almacenamiento del pedido en estado `borrador`.

---

### Phase 3: Control de Pedidos y Notificaciones (Sprint 3)
*Objetivo: Habilitar el flujo de verificación en depósito, manejo de faltantes y alertas en tiempo real.*

* **F3.1. Módulo de Notificaciones y PWA:**
  * Configuración del Service Worker y manifiesto PWA.
  * Implementación de alertas en tiempo real vía WebSockets (`Socket.io`) / SSE para avisar a depósito cuando ingresa un nuevo `borrador`.
  * Configuración de usuario para **activar/desactivar** notificaciones por sesión o dispositivo.
* **F3.2. Pantalla de Verificación de Depósito (Picking):**
  * Vista de pedidos en estado `borrador` para el operario.
  * Capacidad de marcar productos encontrados, ajustar cantidades reales o excluir ítems faltantes en los subdocumentos del pedido.
* **F3.3. Estado "Paralizado" (Ítems Pendientes / Backorder):**
  * Lógica para marcar ítems pendientes (`isPending: true`) y **paralizar** el pedido.
  * Habilitación para retomar y modificar el pedido en el futuro cuando llegue mercadería.
* **F3.4. Flexibilidad de Modificación:**
  * Permiso para que cualquier usuario autorizado edite el pedido en curso.

---

### Phase 4: Gestión de Facturación y Cierre de Ciclo (Sprint 4)
*Objetivo: Generar los datos estructurados para facturar y cerrar el ciclo logístico.*

* **F4.1. Notificación para Facturación:**
  * Alertas automáticas para el área de facturación cuando un pedido está verificado y listo.
  * Opción de activar/desactivar notificaciones de facturación.
* **F4.2. Módulo de Datos Estructurados:**
  * Vista dedicada que **genera y presenta de forma estructurada** los datos finales (productos, cantidades verificadas, códigos, descuentos) listos para copiar/cargar en el sistema externo de facturación.
* **F4.3. Verificación Post-Facturación y Despacho:**
  * Pantalla de control sobre la copia *Duplicado* del sistema externo.
  * Transición de estado a `entregado` al confirmar el despacho de la mercadería por el repartidor.

---

### Phase 5: Pruebas Integrales, Despliegue y Puesta en Marcha (Sprint 5)
*Objetivo: Asegurar la estabilidad, realizar pruebas de campo con los vendedores y poner en producción.*

* **F5.1. Pruebas End-to-End (E2E):**
  * Simulación del flujo completo: Creación (vendedor) ➔ Verificación/Paralizado (depósito) ➔ Notificaciones ➔ Estructura para facturar ➔ Control post-factura y entrega.
* **F5.2. Despliegue (Deployment):**
  * Configuración de MongoDB Atlas y del servidor definitivo (Local o Cloud).
  * Instalación de la PWA en los dispositivos móviles de los vendedores y terminales de depósito/facturación.
* **F5.3. Capacitación y Salida en Vivo:**
  * Capacitación al personal operativo y puesta en marcha oficial del Sistema de Gestión de Inventario.