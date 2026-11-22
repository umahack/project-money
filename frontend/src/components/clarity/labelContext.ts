import { createContext } from 'react';
import type { ValueClassification } from '../../clarity/contracts';

/**
 * Set by `OutcomeCard` to the classification its header already states once for the whole card.
 * `ClassifiedValue` reads it so a value that matches does not repeat the label as a second visible
 * badge. Values outside a card get `null` and always show their own label.
 */
export const OutcomeLabelContext = createContext<ValueClassification | null>(null);
