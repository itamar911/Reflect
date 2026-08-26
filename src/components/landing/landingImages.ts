export interface PlaceholderVideo {
  id: string;
  name: string;
  quote: string;
  poster?: string;
  videoUrl?: string;
}

export const landingImages = {
  videos: [
    {
      id: 'video-1',
      name: 'אימרי, סוחר יומי',
      quote: 'הפעם הראשונה שמשהו עצר אותי באמת',
      videoUrl: '/video/creative-1-web.mp4',
      poster: '/video/creative-1-poster.jpg',
    },
    { id: 'video-2', name: 'סוחרת מניות', quote: 'ראיתי את הדפוסים שלי שחור על גבי לבן' },
    { id: 'video-3', name: 'סוחר קריפטו', quote: 'החוקים שלי, לא עוד עצה גנרית' },
    { id: 'video-4', name: 'סוחר פורקס', quote: 'משמעת שאני יכול למדוד' },
  ] as PlaceholderVideo[],
};
