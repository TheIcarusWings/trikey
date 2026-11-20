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
  Gauge,
  House,
  HouseWifi,
  Info,
  KeyRound,
  List,
  Lock,
  LockKeyhole,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcwKey,
  Server,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Tag,
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

/** A phone with a check on its screen: the Security tab's "Phone safety" tile. */
export const PhoneCheck = createLucideIcon('PhoneCheck', [
  ['rect', { x: '7', y: '3', width: '10', height: '18', rx: '2', key: 'body' }],
  ['path', { d: 'M10 12l1.5 1.5L14 10.5', key: 'check' }],
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
