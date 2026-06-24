'use client';

import ScaleSelector from './ScaleSelector';

const STATES = [
  { value: 1, color: '#ef4444', label: 'גרוע' },
  { value: 2, color: '#f97316', label: 'רע' },
  { value: 3, color: '#eab308', label: 'נייטרל' },
  { value: 4, color: '#84cc16', label: 'טוב' },
  { value: 5, color: '#22c55e', label: 'מעולה' },
];

interface EmotionalStateSliderProps {
  value: number;
  onChange: (v: number) => void;
}

export default function EmotionalStateSlider({ value, onChange }: EmotionalStateSliderProps) {
  return <ScaleSelector title="מצב רגשי" value={value} onChange={onChange} states={STATES} />;
}
