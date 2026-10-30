import { redirect } from 'next/navigation';
import { getInitialSessionUser } from '@/lib/auth';
import LoginForm from './LoginForm';

/**
 * /login es un Server Component para poder redirigir a la app cuando la
 * cookie de sesión sigue vigente. El formulario queda en `LoginForm`
 * (Client Component) porque maneja estado y submit.
 *
 * La lectura de `cookies()` es intencionalmente bloqueante: evita mostrar el
 * formulario a un usuario ya autenticado. El proxy deja `/login` público, así
 * que esta es la única puerta de entrada que decide el redirect.
 */
export const instant = false;

export default async function LoginPage() {
  const user = await getInitialSessionUser();

  if (user) redirect('/');

  return <LoginForm />;
}
