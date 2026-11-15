import { useState } from 'react';
import { Card, PageTitle } from '../components/ui';
import { CoinCatcher } from '../games/CoinCatcher';
import { Snake } from '../games/Snake';

export function Arcade() {
  const [game, setGame] = useState<'coin' | 'snake'>('coin');
  return (
    <>
      <PageTitle title="Arcade 🎮" sub="Bored of budgeting? Take a quick break." />
      <Card className="arcade-card">
        <div className="segmented">
          <button className={game === 'coin' ? 'on' : ''} onClick={() => setGame('coin')}>🪙 Coin Catcher</button>
          <button className={game === 'snake' ? 'on' : ''} onClick={() => setGame('snake')}>🐍 Snake Saver</button>
        </div>
        {game === 'coin' ? <CoinCatcher key="c" /> : <Snake key="s" />}
      </Card>
    </>
  );
}
