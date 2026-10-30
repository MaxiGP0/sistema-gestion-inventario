'use client';

const PRODUCT_BOTH_COLUMNS = [
  'Marca',
  'Codigo',
  'Nombre',
  'Precio s/IVA o Precio c/IVA (al menos uno)',
  'Imagen (opcional, solo productos nuevos)',
] as const;

const PRODUCT_NAME_COLUMNS = ['Marca', 'Codigo', 'Nombre'] as const;

const PRODUCT_PRICE_COLUMNS = [
  'Marca',
  'Codigo',
  'Precio s/IVA o Precio c/IVA (al menos uno)',
] as const;

const CLIENT_COLUMNS = ['Codigo', 'Nombre', 'Direccion', 'Ciudad', 'DescuentoGeneral'] as const;

function ColumnList({ columns }: { columns: readonly string[] }) {
  return (
    <>
      {columns.map((column, index) => (
        <span key={column}>
          {index > 0 ? ', ' : ''}
          <code className="font-semibold text-action-text">{column}</code>
        </span>
      ))}
    </>
  );
}

/** Guía de columnas del Excel. Se carga debajo del formulario, fuera del camino crítico. */
export default function ImportHelp() {
  return (
    <div className="mt-8 space-y-2 rounded-lg border border-border bg-surface-muted p-4 text-xs text-muted">
      <p className="font-semibold text-status-draft">Formato requerido para el Excel:</p>
      <ul className="list-inside list-disc space-y-1">
        <li>
          <strong>Productos, Nombre y precio:</strong> columnas{' '}
          <ColumnList columns={PRODUCT_BOTH_COLUMNS} />. Actualiza los productos existentes y crea
          los que todavía no existen.
        </li>
        <li>
          <strong>Productos, Solo nombre:</strong> columnas{' '}
          <ColumnList columns={PRODUCT_NAME_COLUMNS} />. Las columnas de precio se ignoran y solo se
          actualizan productos existentes.
        </li>
        <li>
          <strong>Productos, Solo precio:</strong> columnas{' '}
          <ColumnList columns={PRODUCT_PRICE_COLUMNS} />. La columna Nombre se ignora y solo se
          actualizan productos existentes.
        </li>
        <li>
          <strong>Imagen:</strong> solo se usa al crear productos nuevos. Nunca modifica la imagen
          de un producto existente.
        </li>
        <li>
          <strong>Clientes:</strong> columnas <ColumnList columns={CLIENT_COLUMNS} /> (descuento
          entre 0 y 100).
        </li>
        <li>
          Las marcas se normalizan (sin distinguir mayúsculas ni acentos): “Bagó” y “BAGO” se
          resuelven como la misma marca. Los códigos repetidos dentro del archivo se informan como
          duplicados y se omite la segunda fila.
        </li>
      </ul>
    </div>
  );
}
