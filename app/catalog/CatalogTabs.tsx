import { Package, Users } from 'lucide-react';
import Tabs from '@/components/ui/Tabs';

type CatalogTab = 'products' | 'clients';

const TABS = [
  { value: 'products', href: '/catalog', label: 'Productos', icon: Package },
  { value: 'clients', href: '/catalog/clients', label: 'Clientes', icon: Users },
] as const;

/** Navegación entre las secciones de solo lectura del catálogo. */
export default function CatalogTabs({ active }: { active: CatalogTab }) {
  return (
    <Tabs
      items={TABS}
      value={active}
      variant="pill"
      ariaLabel="Secciones del catálogo"
      className="mb-6"
    />
  );
}
