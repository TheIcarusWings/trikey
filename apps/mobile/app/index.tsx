import { Redirect } from 'expo-router';
import { useWallet } from '@/data';

/** Entry point: the app on a set-up wallet, the welcome screen otherwise. */
export default function Index() {
  const { onboarded } = useWallet();
  return <Redirect href={onboarded ? '/home' : '/welcome'} />;
}
