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
