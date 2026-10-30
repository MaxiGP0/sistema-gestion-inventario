# Design tokens y primitives (Figma 01 + 02)

> Fuente: archivo Figma `Sistema de Gestión de Inventario / Sistema de diseño`, frames `01 Foundations` y
> `02 Components` (claro/oscuro). Esta capa vive en `app/globals.css` y en
> `components/ui/*`.
>
> **Alcance:** tokens, tipografía, primitives y estados. Las pantallas de
> aplicación siguen usando sus estilos actuales hasta las fases 3–5.

## Decisiones implementadas

- **Marca:** ultramar `#0b0d9f` (logo original, sin rediseñar).
- **Acción:** índigo `#4338ca` en claro y `#a5b4fc` en oscuro.
- **Tipografía:** Inter para UI; IBM Plex Mono para códigos, IDs e importes
  técnicos. Se eliminó Geist Mono para no cargar dos monos.
- **Radios:** 4/6/8/12/16 px.
- **Objetivo táctil:** 44 px en mobile; densidad de escritorio 36–40 px.
- **Estados:** Borrador ámbar, Paralizado rojo, Listo para facturar violeta,
  Control post-factura cian, Entregado esmeralda. Siempre con etiqueta.

> Si más adelante se decide que el botón primario use el ultramar de marca en
> vez del índigo de acción, se cambia `--action` y sus derivados en un solo
> lugar. Los componentes no necesitan tocarse.

## Tokens semánticos

Los valores cambian con `[data-theme='dark']`. Los componentes usan las clases
semánticas, no `dark:` para estos colores.

| Token | Clase | Claro | Oscuro |
| --- | --- | --- | --- |
| `--surface` | `bg-surface` | `#ffffff` | `#0f172a` |
| `--surface-muted` | `bg-surface-muted` | `#f8fafc` | `#0b1220` |
| `--field` | `bg-field` | `#ffffff` | `#0f172a` |
| `--foreground` | `text-foreground` | `#0f172a` | `#f8fafc` |
| `--muted` | `text-muted` | `#475569` | `#cbd5e1` |
| `--subtle` | `text-subtle` | `#64748b` | `#94a3b8` |
| `--border` | `border-border` | `#e2e8f0` | `#1e293b` |
| `--border-strong` | `border-border-strong` | `#64748b` | `#94a3b8` |
| `--focus` | `ring-focus` / `border-focus` | `#4f46e5` | `#a5b4fc` |
| `--action` | `bg-action` / `text-action` | `#4338ca` | `#a5b4fc` |
| `--action-hover` | `hover:bg-action-hover` | `#3730a3` | `#c7d2fe` |
| `--action-soft` | `bg-action-soft` | `#eef2ff` | `#20264b` |
| `--action-fg` | `text-action-fg` | `#ffffff` | `#020617` |
| `--brand` | `bg-brand` | `#0b0d9f` | `#0b0d9f` |
| `--brand-soft` | `bg-brand-soft` | `#eef0ff` | `#20264b` |

### Estados operativos

| Estado | Token | Claro (fg / soft / border) | Oscuro (fg / soft / border) |
| --- | --- | --- | --- |
| Borrador | `status-draft` | `#92400e` / `#fffbeb` / `#d97706` | `#fcd34d` / `#38280d` / `#fcd34d` |
| Paralizado | `status-blocked` | `#b91c1c` / `#fef2f2` / `#dc2626` | `#fca5a5` / `#3b171c` / `#fca5a5` |
| Listo para facturar | `status-ready` | `#6d28d9` / `#f5f3ff` / `#7c3aed` | `#c4b5fd` / `#2e1e46` / `#c4b5fd` |
| Control post-factura | `status-control` | `#155e75` / `#ecfeff` / `#0891b2` | `#67e8f9` / `#10323c` / `#67e8f9` |
| Entregado | `status-delivered` | `#065f46` / `#ecfdf5` / `#059669` | `#6ee7b7` / `#0d332a` / `#6ee7b7` |

Clases: `bg-status-*`, `bg-status-*-soft`, `text-status-*`,
`border-status-*-border`.

## Tipografía

| Uso | Tamaño / línea | Peso |
| --- | --- | --- |
| Título documental | 32 / 40 | 600 |
| Sección | 20 / 28 | 600 |
| Subtítulo | 16 / 24 | 600 |
| Cuerpo / control | 14 / 21 | 400–500 |
| Ayuda / metadato | 12 / 18 | 400 |
| Código | 14 / 21 | 400–600 (mono) |

Reglas: 12 px es el mínimo; 14 px es la lectura base; números tabulares en
importes y cantidades; `font-mono` para códigos/IDs; `font-sans` para el resto.

## Primitives disponibles

| Componente | Archivo | Notas |
| --- | --- | --- |
| `Button` | `components/ui/Button.tsx` | `variant="primary" \| "secondary" \| "destructive" \| "ghost"`, `size`, `loading`, `loadingLabel`. Conserva `tone`/`appearance` por compatibilidad. |
| `Card` | `components/ui/Card.tsx` | Borde semántico; `elevation="none" \| "1" \| "2"`. |
| `Table` | `components/ui/Table.tsx` | `density="comfortable" \| "compact"` y `dense` legacy. |
| `Modal` | `components/ui/Modal.tsx` | `center`, `sheet-top`, `sheet-bottom`, `responsive`. |
| `StatusBadge` | `components/StatusBadge.tsx` | Los 5 estados y las variantes por rol. |
| `Toast` | `components/Toast.tsx` | `success`, `error`, `warning`, `info`; `role`/`aria-live`. |
| `ConfirmDialog` | `components/ConfirmDialog.tsx` | Usa `Button` y tokens. |
| `Field` | `components/ui/Field.tsx` | Etiqueta, obligatorio/opcional, ayuda y error. |
| `Input` / `SearchInput` | `components/ui/Input.tsx` | 44 px; icono líder opcional. |
| `Select` | `components/ui/Select.tsx` | Select nativo con chevron. |
| `Textarea` | `components/ui/Textarea.tsx` | Comentarios/observaciones. |
| `Checkbox` / `Radio` | `components/ui/Checkbox.tsx`, `Radio.tsx` | Etiqueta y mensajes accesibles. |
| `Switch` | `components/ui/Switch.tsx` | `role="switch"` y etiqueta asociada. |
| `AppShell` | `components/app-shell/AppShell.tsx` | Sidebar desktop, top bar y menú móvil; navegación filtrada por rol. |
| `EmptyState` | `components/ui/EmptyState.tsx` | Icono, título, descripción y acción. |
| `Skeleton` | `components/ui/Skeleton.tsx` | Sin cifras ficticias; respeta reduced motion. |
| `QuantityStepper` | `components/ui/QuantityStepper.tsx` | Entrada directa, límites y rol `spinbutton`; 36/44 px. |
| `Tabs` | `components/ui/Tabs.tsx` | Navegación por links o botones; variantes `underline`/`pill`. |
| `SegmentedControl` | `components/ui/SegmentedControl.tsx` | Selección única entre pocas opciones. |
| `FilterChips` | `components/ui/FilterChips.tsx` | Filtros de selección única con contadores. |

## Reglas de uso

1. Para código nuevo, usar clases semánticas (`bg-surface`, `text-muted`,
   `border-border`, `text-status-*`) y no `slate-*`/`blue-*` con `dark:`.
2. **No** usar `tone="emerald"` para acciones de depósito. El verde queda
   reservado a “Entregado”.
3. Una acción primaria por vista; el resto `secondary`/`ghost`.
4. 44 px de alto mínimo en mobile; inputs de 16 px para evitar zoom en iOS.
5. Mantener `data-testid` existentes y las safe-area de la PWA.
6. El modo oscuro se resuelve con tokens; no crear copias de clases para dark.

## Pendiente para las próximas fases

- Migrar bandejas y detalle/picking/facturación al AppShell.
- Revisar los estados de detalle, picking y post-factura que el 03 dejó incompletos.
- `ProductRow`, `OrderCard` con los 5 estados y `Pagination`.
- `Sheet` genérico (el `Modal` ya tiene variantes, falta documentarlo como
  componente de producto).
- `Pipeline` mobile y `Import` mobile.
- Migrar las pantallas existentes a los primitives; hasta entonces conviven
  estilos legacy y nuevos.
