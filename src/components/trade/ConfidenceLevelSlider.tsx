'use client';

import ScaleSelector from './ScaleSelector';

const STATES = [
  { value: 1, color: '#ef4444', label: 'נמוך מאוד' },
  { value: 2, color: '#f97316', label: 'נמוך' },
  { value: 3, color: '#eab308', label: 'בינוני' },
  { value: 4, color: '#84cc16', label: 'גבוה' },
  { value: 5, color: '#22c55e', label: 'גבוה מאוד' },
];

interface ConfidenceLevelSliderProps {
  value: number;
  onChange: (v: number) => void;
}

export default function ConfidenceLevelSlider({ value, onChange }: ConfidenceLevelSliderProps) {
  return <ScaleSelector title="רמת ביטחון" value={value} onChange={onChange} states={STATES} />;
}
