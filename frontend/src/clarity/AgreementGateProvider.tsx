import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../state';
import { useDataUseGate } from './DataUseGateProvider';

export interface AgreementGateValue {
  /** True once the signed-in user chose "Not now, just look around" during this sign-in. */
  notNow: boolean;
  /** Records the choice. Memory only; never written to storage. */
  setNotNow: () => void;
  /**
   * True exactly when signed-in navigation to a non-exempt route should be
   * redirected to the Agreement_Page.
   */
  mustAgree: boolean;
}

const AgreementGateContext = createContext<AgreementGateValue>({
  notNow: false,
  setNotNow: () => {},
  mustAgree: false,
});

export function useAgreementGate(): AgreementGateValue {
  return useContext(AgreementGateContext);
}

export function AgreementGateProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const gate = useDataUseGate();
  const [notNow, setNotNowFlag] = useState(false);
  // Resets on sign-out and on a change of signed-in user. Never reads or writes storage.
  const lastUserId = useRef(user?.id);
  useEffect(() => {
    if (lastUserId.current !== user?.id) {
      lastUserId.current = user?.id;
      setNotNowFlag(false);
    }
  }, [user?.id]);

  const setNotNow = useCallback(() => setNotNowFlag(true), []);
  const mustAgree = gate.status === 'required' && !notNow;
  const value = useMemo(() => ({ notNow, setNotNow, mustAgree }), [notNow, setNotNow, mustAgree]);

  return <AgreementGateContext.Provider value={value}>{children}</AgreementGateContext.Provider>;
}
