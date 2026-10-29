import { Redirect } from 'expo-router';
import { useWallet } from '@/data';

/** Entry point: the app on a set-up wallet, the welcome screen otherwise. */
export default function Index() {
  const { onboarded, recovering } = useWallet();
  // A phone in the middle of a recovery goes back to watching it.
  return <Redirect href={onboarded ? '/home' : recovering ? '/recover/waiting' : '/welcome'} />;
}
