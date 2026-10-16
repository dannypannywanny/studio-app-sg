// Rooms are the school's in-person locations (locations/{id} with isOnline false); the online location
// (e.g. Zoom) is not a room. A school with one room never sees a room picker: its lessons use that room.
import { collection, query } from 'firebase/firestore';
import { useMemo } from 'react';
import { db } from '../firebase';
import { useQuery } from '../hooks';
import { useSchoolId } from '../session';
import type { Ts } from '../types';

export interface Place {
  name: string;
  publicName?: string;
  isOnline: boolean;
  active: boolean;
  createdAt?: Ts;
}

export function useRooms() {
  const schoolId = useSchoolId();
  const live = useQuery<Place>(`locations:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'locations')));
  return useMemo(() => {
    // Oldest first: the school's first room is its main room and the default for new lessons.
    const made = (l: Place) => l.createdAt?.toMillis() ?? Number.MAX_SAFE_INTEGER;
    const rooms = live.data
      .filter((l) => !l.isOnline && l.active !== false)
      .sort((a, b) => made(a) - made(b) || a.name.localeCompare(b.name));
    const online = live.data.find((l) => l.isOnline && l.active !== false) ?? null;
    const byId = new Map(live.data.map((l) => [l.id, l]));
    return { rooms, online, byId, loading: live.loading, many: rooms.length > 1 };
  }, [live.data, live.loading]);
}
