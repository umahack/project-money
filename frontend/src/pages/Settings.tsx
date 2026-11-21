import { PageTitle } from '../components/ui';
import { DevicesPanel } from '../components/DevicesPanel';
import { ChangePassword } from '../components/ChangePassword';
import { ExportData } from '../components/ExportData';
import { CategoryManager } from '../components/CategoryManager';
import { ProfileSettings } from '../components/ProfileSettings';
import { DangerZone } from '../components/DangerZone';
import { AnalyticsControl } from '../components/clarity/AnalyticsControl';

export function Settings() {
  return (
    <>
      <PageTitle
        title="Settings ⚙️"
        sub="Device sign-ins, account password, and data export."
      />
      <ProfileSettings />
      <DevicesPanel />
      <CategoryManager />
      <ChangePassword />
      <AnalyticsControl />
      <ExportData />
      <DangerZone />
    </>
  );
}
