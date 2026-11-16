import { Card, Empty, PageTitle } from '../../components/ui';
import { useAuth } from '../../state';
import { DevicesPanel } from '../../components/DevicesPanel';
import { ChangePassword } from '../../components/ChangePassword';

export function AdminAccount() {
  const { user: me } = useAuth();
  if (!me?.is_admin) return <Card><Empty emoji="🔒" title="Admins only" /></Card>;

  return (
    <>
      <PageTitle
        title="Your admin account 🪪"
        sub={`Signed in as ${me.email}. Everything here applies to this admin login only.`}
      />
      <DevicesPanel />
      <ChangePassword />
    </>
  );
}
