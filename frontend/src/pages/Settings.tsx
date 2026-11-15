import { PageTitle } from '../components/ui';
import { DevicesPanel } from '../components/DevicesPanel';
import { ChangePassword } from '../components/ChangePassword';
import { ExportData } from '../components/ExportData';
import { CategoryManager } from '../components/CategoryManager';

export function Settings() {
  return (
    <>
      <PageTitle
        title="Settings ⚙️"
        sub="Device sign-ins, account password, and data export."
      />
      <DevicesPanel />
      <CategoryManager />
      <ChangePassword />
      <ExportData />
    </>
  );
}
