export interface PlaceholderImage {
  id: string;
  label: string;
  src?: string;
}

export interface PlaceholderVideo {
  id: string;
  name: string;
  quote: string;
  poster?: string;
  videoUrl?: string;
}

export const landingImages = {
  heroScreenshot: {
    id: 'hero-screenshot',
    label: 'צילום מסך: רגע האזהרה בטופס פתיחת העסקה',
  } satisfies PlaceholderImage,

  features: [
    { id: 'feature-1', label: 'צילום מסך: בניית חוק משמעת אישי' },
    { id: 'feature-2', label: 'צילום מסך: טופס תכנון עסקה עם בדיקה בזמן אמת' },
    { id: 'feature-3', label: 'צילום מסך: רדאר ציון משמעת' },
    { id: 'feature-4', label: 'צילום מסך: תחקיר AI לאחר עסקה' },
    { id: 'feature-5', label: 'צילום מסך: יומן חודשי חכם' },
    { id: 'feature-6', label: 'צילום מסך: שיחה עם מאמן AI אישי' },
  ] satisfies PlaceholderImage[],

  gallery: [
    { id: 'gallery-1', label: 'לוח הבקרה הראשי' },
    { id: 'gallery-2', label: 'היומן החודשי' },
    { id: 'gallery-3', label: 'רדאר המשמעת' },
    { id: 'gallery-4', label: 'תחקיר העסקה' },
  ] satisfies PlaceholderImage[],

  videos: [
    { id: 'video-1', name: 'סוחר יומי, פיוצ׳רס', quote: 'הפעם הראשונה שמשהו עצר אותי באמת' },
    { id: 'video-2', name: 'סוחרת מניות', quote: 'ראיתי את הדפוסים שלי שחור על גבי לבן' },
    { id: 'video-3', name: 'סוחר קריפטו', quote: 'החוקים שלי, לא עוד עצה גנרית' },
    { id: 'video-4', name: 'סוחר פורקס', quote: 'משמעת שאני יכול למדוד' },
  ] as PlaceholderVideo[],
};
