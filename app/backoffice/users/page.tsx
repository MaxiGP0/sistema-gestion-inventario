import type { Metadata } from 'next';
import { Suspense } from 'react';
import BackofficePageSkeleton from '@/components/BackofficePageSkeleton';
import { requireAdminPage } from '@/lib/auth-page';
import { listUsers } from '@/lib/users';
import UsersManager from './UsersManager';

export const metadata: Metadata = {
  title: 'Usuarios',
};

export default function UsersBackofficePage() {
  return (
    <Suspense fallback={<BackofficePageSkeleton />}>
      <UsersContent />
    </Suspense>
  );
}

async function UsersContent() {
  const session = await requireAdminPage();
  const users = await listUsers();

  return <UsersManager initialUsers={users} currentUserId={session.userId} />;
}
