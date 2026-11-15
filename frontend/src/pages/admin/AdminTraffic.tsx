import { Card, Empty, PageTitle } from '../../components/ui';
import { useAuth } from '../../state';
import { VisitorsPanel } from '../../components/VisitorsPanel';
import { AuditLogPanel } from '../../components/AuditLogPanel';

export function AdminTraffic() {
  const { user: me } = useAuth();
  if (!me?.is_admin) return <Card><Empty emoji="🔒" title="Admins only" /></Card>;

  return (
    <>
      <PageTitle title="Traffic & audit 👀" sub="Daily visitor counts, top pages, and an append-only log of privileged actions." />
      <VisitorsPanel />
      <AuditLogPanel />
    </>
  );
}
