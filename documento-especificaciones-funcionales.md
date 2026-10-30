# Documento de Especificaciones Funcionales (DEF)
## Sistema de Gestión de Inventario — Gestión Integral de Pedidos

---

### 1. Resumen del Proyecto y Objetivo
El objetivo de este proyecto es desarrollar el **Sistema de Gestión de Inventario**, una aplicación web/móvil que digitalice y optimice el flujo operativo actual (basado en planillas de marcas). La app abarcará tres grandes módulos integrados:
1. **Creación de Pedidos** (por parte de los vendedores en calle).
2. **Control de Pedidos y Verificación** (por parte de depósito/operadores).
3. **Gestión para Facturación** (preparación de datos estructurados para el sistema externo de facturación y control post-facturación).

El entorno de trabajo es de **confianza**, por lo que no se establecerán restricciones estrictas de roles y permisos; todos los usuarios (vendedores, operarios, facturistas y supervisores) tendrán acceso completo a las tres secciones y la capacidad de visualizar y modificar los estados según sea necesario.

---

### 2. Módulos y Funcionalidades del Sistema

#### Módulo 1: Creación de Pedidos (Vendedores de Calle)
* **Búsqueda y Selección de Clientes:**
  * Búsqueda rápida por **nombre**, **dirección** o **código de cliente**.
  * Visualización y aplicación de **descuentos especiales por cliente**, los cuales pueden ser de dos tipos:
    * **Descuento general** (sobre el total o subtotal).
    * **Descuento por marca**.
* **Carga de Productos por Marca y Búsqueda Jerárquica:**
  * El flujo de búsqueda y selección se realiza bajo la estructura **Marca -> Nombre o Código**.
  * Cada marca mantiene sus propias características y estilos de códigos (códigos alfanuméricos como `Cxxxx`, `Bxxxx`, o marcas sin prefijo específico).
  * Visualización de la **imagen del producto** y su **precio actualizable**.
  * Ingreso directo de la **cantidad** deseada por el comprador utilizando la estructura de planilla.

#### Módulo 2: Control de Pedidos y Verificación de Depósito
* **Borrador y Estado Inicial:**
  * El pedido ingresa inicialmente como un *Borrador* (planilla con nombres, códigos y cantidades solicitadas).
* **Verificación de Mercadería (Picking físico):**
  * El operario recorre el depósito buscando los productos.
  * Opciones de marcado y ajuste físico en el sistema:
    * Marcar los productos encontrados y listos.
    * Modificar la cantidad en caso de haber menos stock disponible del solicitado.
    * Omitir/desmarcar el producto en caso de no haber stock (no se envía).
* **Gestión de Ítems Pendientes (Backorder):**
  * Si se dejan ítems pendientes, **el pedido queda en estado "paralizado"**, permitiendo ser retomado y modificado en el futuro cuando llegue la mercadería faltante.
* **Flexibilidad de Modificación:**
  * Cualquier usuario autorizado puede modificar el pedido en esta etapa (por ejemplo, si los compradores agregan nuevos ítems a última hora).

#### Módulo 3: Gestión para Facturación y Verificación Post-Facturación
* **Preparación de Datos Estructurados:**
  * Una vez verificado el pedido por depósito, la aplicación **genera exclusivamente los datos estructurados** para facturación (productos, cantidades finales verificadas, códigos y descuentos generales/por marca), facilitando su lectura por parte del facturista.
* **Proceso de Facturación Externo y Control Post-Facturación:**
  * El facturista utiliza dichos datos en su aplicación externa para generar los comprobantes (Original y Duplicado).
  * Una vez facturado, el operario realiza una verificación sobre la copia *Duplicado* (marcando las cantidades de cada elemento por convención de control).
* **Estado Final (Entregado):**
  * Una vez verificado, el pedido pasa al estado *Entregado*, indicando que el repartidor despachó la mercadería al comprador.

---

### 3. Módulo de Notificaciones del Sistema
* **Alertas Operativas:**
  * Notificaciones automáticas para alertar al personal de depósito cuando ingresa un nuevo **"Borrador"**.
  * Notificaciones automáticas para alertar al área de facturación cuando hay una **"Estructura lista para facturar"**.
* **Control de Notificaciones:**
  * Funcionalidad para **activar o desactivar** dichas notificaciones según la preferencia del usuario en su dispositivo/sesión.

---

### 4. Gestión y Mantenimiento de Datos (Backoffice / Catálogo)
* **Actualización Manual y Masiva:**
  * **Modo manual:** Permite la carga y edición individual de clientes, productos, marcas y precios.
  * **Modo masivo (Importación por Excel):** Capacidad de subir archivos en formato Excel (`.xlsx` / `.csv`) para actualizar de forma rápida y automatizada el listado de productos, precios actualizados y cartera de clientes.

---

### 5. Consideraciones de Seguridad y No Funcionales
* **Seguridad y Acceso:** La aplicación requerirá un mecanismo de **autenticación mediante contraseña privada** para restringir el acceso a usuarios autorizados de la distribuidora.
* **Interfaz Adaptada:** Interfaz ágil y limpia para dispositivos móviles y de escritorio.
* **Acceso Libre y Colaborativo:** Dentro de la aplicación (una vez autenticados), se mantiene el entorno de confianza sin restricciones estrictas entre roles.
* **Independencia de Facturación:** La aplicación no emite facturas legales de forma directa, sino que estructura los datos y deja la gestión contable e histórica en manos del software externo del facturista.
