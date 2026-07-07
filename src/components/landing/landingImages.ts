export interface PlaceholderImage {
  id: string;
  label: string;
  src?: string;
  objectPosition?: string;
}

export interface PlaceholderVideo {
  id: string;
  name: string;
  quote: string;
  poster?: string;
  videoUrl?: string;
}

export const landingImages = {
  features: [
    {
      id: 'feature-1',
      label: 'צילום מסך: בניית חוק משמעת אישי',
      src: '/landing/feature-rules.png',
    },
    {
      id: 'feature-2',
      label: 'צילום מסך: טופס תכנון עסקה עם בדיקה בזמן אמת',
      src: '/landing/feature-plan.png',
    },
    {
      id: 'feature-3',
      label: 'צילום מסך: רדאר ציון משמעת',
      src: '/landing/feature-radar.png',
    },
    {
      id: 'feature-4',
      label: 'צילום מסך: תחקיר AI לאחר עסקה',
      src: '/landing/feature-debrief.png',
    },
    {
      id: 'feature-5',
      label: 'צילום מסך: יומן חודשי חכם',
      src: '/landing/feature-calendar.png',
    },
    {
      id: 'feature-6',
      label: 'צילום מסך: שיחה עם מאמן AI אישי',
      src: '/landing/feature-coach.png',
      objectPosition: 'right center',
    },
  ] satisfies PlaceholderImage[],

  gallery: [
    { id: 'gallery-1', label: 'לוח הבקרה הראשי', src: '/landing/gallery-dashboard.png' },
    { id: 'gallery-2', label: 'תובנות וסטטיסטיקה', src: '/landing/gallery-stats.png' },
  ] satisfies PlaceholderImage[],

  videos: [
    { id: 'video-1', name: 'סוחר יומי, פיוצ׳רס', quote: 'הפעם הראשונה שמשהו עצר אותי באמת' },
    { id: 'video-2', name: 'סוחרת מניות', quote: 'ראיתי את הדפוסים שלי שחור על גבי לבן' },
    { id: 'video-3', name: 'סוחר קריפטו', quote: 'החוקים שלי, לא עוד עצה גנרית' },
    { id: 'video-4', name: 'סוחר פורקס', quote: 'משמעת שאני יכול למדוד' },
  ] as PlaceholderVideo[],
};
