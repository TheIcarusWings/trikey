import { createLucideIcon } from 'lucide-react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/theme/use-theme';

export {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Cloud,
  Coins,
  CloudUpload,
  Copy,
  Delete,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  House,
  HouseWifi,
  Info,
  KeyRound,
  List,
  Lock,
  LockKeyhole,
  Plus,
  QrCode,
  Server,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  TriangleAlert,
  UserPlus,
  Vault,
} from 'lucide-react-native';

/**
 * A hardware wallet, drawn as in the designs (a tall narrow device with a notch).
 * Same props as any lucide icon, so it works with <Icon as={HardwareWallet} />.
 */
export const HardwareWallet = createLucideIcon('HardwareWallet', [
  ['rect', { x: '7', y: '2', width: '10', height: '20', rx: '3', key: 'body' }],
  ['path', { d: 'M10 6h4', key: 'notch' }],
]);

/** The Trikey mark: three keys on a triangle. The top one is the only orange in the app. */
export function Logo({ size = 88 }: { size?: number }) {
  const { colors } = useTheme();
  return (
    <Svg
      width={size}
      height={(size * 80) / 88}
      viewBox="0 0 88 80"
      role="img"
      accessibilityLabel="Trikey logo">
      <Path d="M44 14 L16 62 L72 62 Z" fill="none" stroke={colors.ink} strokeWidth={3} strokeLinejoin="round" />
      <Circle cx={44} cy={14} r={10} fill={colors.brand} />
      <Circle cx={16} cy={62} r={10} fill={colors.ink} />
      <Circle cx={72} cy={62} r={10} fill={colors.ink} />
    </Svg>
  );
}
