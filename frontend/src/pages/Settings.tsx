import { Link } from 'react-router-dom';
import { PageTitle } from '../components/ui';
import { DevicesPanel } from '../components/DevicesPanel';
import { ChangePassword } from '../components/ChangePassword';
import { ExportData } from '../components/ExportData';
import { CategoryManager } from '../components/CategoryManager';
import { ProfileSettings } from '../components/ProfileSettings';
import { DangerZone } from '../components/DangerZone';
import { AnalyticsControl } from '../components/clarity/AnalyticsControl';
import { CategoryMemoryPanel } from '../components/clarity/CategoryMemoryPanel';
import { DATA_USE_REASON_ID } from '../components/clarity/DataUseGate';
import '../components/clarity/dataUse.css';
import { useDataUseGate } from '../clarity/DataUseGateProvider';
import { useAgreementGate } from '../clarity/AgreementGateProvider';

/**
 * Shown on Settings (an Exempt_Route) while Paused_Entries applies: the notice is
 * required and the user chose "Not now". With the rollout flag off the gate status
 * is always 'disabled', so this renders nothing.
 */
function PausedEntriesBanner() {
  const gate = useDataUseGate();
  const { notNow } = useAgreementGate();
  if (!notNow || gate.status !== 'required') return null;
  return (
    <div className="clarity-gate-paused" aria-describedby={DATA_USE_REASON_ID}>
      <p>
        New entries are paused because the data-use notice has not been acknowledged.{' '}
        <Link to="/agreement">Review the data-use notice</Link> to turn them back on.
      </p>
      <p>Exporting, correcting, and deleting your data, and turning Product Analytics off, stay available below.</p>
    </div>
  );
}

export function Settings() {
  return (
    <>
      <PageTitle
        title="Settings ⚙️"
        sub="Device sign-ins, account password, and data export."
      />
      <PausedEntriesBanner />
      <ProfileSettings />
      <DevicesPanel />
      <CategoryManager />
      <ChangePassword />
      <AnalyticsControl />
      <CategoryMemoryPanel />
      <ExportData />
      <DangerZone />
    </>
  );
}
