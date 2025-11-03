import React, { Suspense } from 'react';
import HomeClient from '@/app/HomeClient';

export default function Page() {
  return (
    <Suspense fallback={<div />}> 
      <HomeClient />
    </Suspense>
  );
}
