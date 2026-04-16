// ============================================================
// vClaw — Cross-Platform Workload Analyzer
// Assesses VMs for migration between VMware vSphere and AWS EC2
// ============================================================

import type { MigrationVMConfig, MigrationDisk, DiskFormat } from './types.js';

// ---- Interfaces ----

export interface WorkloadAnalysis {
  source: { provider: string; vmName: string; config: MigrationVMConfig };
  target: {
    provider: string;
    recommended: TargetRecommendation;
    alternatives: TargetRecommendation[];
  };
  storage: { currentGB: number; estimatedTargetGB: number; format: DiskFormat };
  network: { considerations: string[] };
  costEstimate?: { monthlyUSD: number; breakdown: Record<string, number> };
  risks: string[];
  migrationTimeEstimateMinutes: number;
}

export interface TargetRecommendation {
  // For AWS target
  instanceType?: string;
  ebsVolumeType?: string;
  // For VMware target
  cpuCount?: number;
  memoryMiB?: number;
  guestOS?: string;
  // Common
  estimatedMonthlyCost?: number;
  notes: string[];
}

// ---- Internal types ----

interface InstanceSpec {
  instanceType: string;
  family: string;
  vCPU: number;
  memoryMiB: number;
  hourlyRate: number;
}

// ---- Instance catalog ----

const INSTANCE_CATALOG: InstanceSpec[] = [
  { instanceType: 't3.micro',    family: 't3', vCPU: 2,  memoryMiB: 1024,    hourlyRate: 0.0104 },
  { instanceType: 't3.small',    family: 't3', vCPU: 2,  memoryMiB: 2048,    hourlyRate: 0.0208 },
  { instanceType: 't3.medium',   family: 't3', vCPU: 2,  memoryMiB: 4096,    hourlyRate: 0.0416 },
  { instanceType: 't3.large',    family: 't3', vCPU: 2,  memoryMiB: 8192,    hourlyRate: 0.0832 },
  { instanceType: 'm5.large',    family: 'm5', vCPU: 2,  memoryMiB: 8192,    hourlyRate: 0.096 },
  { instanceType: 'm5.xlarge',   family: 'm5', vCPU: 4,  memoryMiB: 16384,   hourlyRate: 0.192 },
  { instanceType: 'm5.2xlarge',  family: 'm5', vCPU: 8,  memoryMiB: 32768,   hourlyRate: 0.384 },
  { instanceType: 'm5.4xlarge',  family: 'm5', vCPU: 16, memoryMiB: 65536,   hourlyRate: 0.768 },
  { instanceType: 'c5.large',    family: 'c5', vCPU: 2,  memoryMiB: 4096,    hourlyRate: 0.085 },
  { instanceType: 'c5.xlarge',   family: 'c5', vCPU: 4,  memoryMiB: 8192,    hourlyRate: 0.17 },
  { instanceType: 'c5.2xlarge',  family: 'c5', vCPU: 8,  memoryMiB: 16384,   hourlyRate: 0.34 },
  { instanceType: 'c5.4xlarge',  family: 'c5', vCPU: 16, memoryMiB: 32768,   hourlyRate: 0.68 },
  { instanceType: 'r5.large',    family: 'r5', vCPU: 2,  memoryMiB: 16384,   hourlyRate: 0.126 },
  { instanceType: 'r5.xlarge',   family: 'r5', vCPU: 4,  memoryMiB: 32768,   hourlyRate: 0.252 },
  { instanceType: 'r5.2xlarge',  family: 'r5', vCPU: 8,  memoryMiB: 65536,   hourlyRate: 0.504 },
  { instanceType: 'r5.4xlarge',  family: 'r5', vCPU: 16, memoryMiB: 131072,  hourlyRate: 1.008 },
];

const HOURS_PER_MONTH = 730;
const EBS_GP3_COST_PER_GB = 0.08;
const TRANSFER_SPEED_MB_PER_SEC = 100;
const IMPORT_OVERHEAD_MINUTES = 30;

// ---- Helper functions ----

function bytesToGB(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024 * 1024));
}

function totalDiskGB(disks: MigrationDisk[]): number {
  return disks.reduce((sum, d) => sum + bytesToGB(d.capacityBytes), 0);
}

function determinePreferredFamily(cpuCount: number, memoryMiB: number): string {
  const memoryGiB = memoryMiB / 1024;
  const ratioGBPerCore = memoryGiB / cpuCount;

  if (ratioGBPerCore > 8) return 'r5';
  if (cpuCount > 4 && ratioGBPerCore < 4) return 'c5';
  return 'm5';
}

function platformToGuestOS(platform?: string): string {
  if (!platform) return 'otherGuest64';
  const p = platform.toLowerCase();
  if (p.includes('windows')) return 'windows9Server64Guest';
  if (p.includes('linux') || p.includes('unix')) return 'otherLinux64Guest';
  if (p.includes('ubuntu')) return 'ubuntu64Guest';
  if (p.includes('centos')) return 'centos64Guest';
  if (p.includes('rhel') || p.includes('red hat')) return 'rhel8_64Guest';
  return 'otherGuest64';
}

// ---- Main class ----

export class WorkloadAnalyzer {

  /**
   * Look up an EC2 instance type's specs.
   */
  static getInstanceTypeSpecs(
    instanceType: string
  ): { vCPU: number; memoryMiB: number; hourlyRate: number } | null {
    const spec = INSTANCE_CATALOG.find(i => i.instanceType === instanceType);
    if (!spec) return null;
    return { vCPU: spec.vCPU, memoryMiB: spec.memoryMiB, hourlyRate: spec.hourlyRate };
  }

  /**
   * Recommend an EC2 instance type based on CPU and memory requirements.
   * Returns a primary recommendation and up to 2 alternatives.
   */
  static recommendInstanceType(
    cpuCount: number,
    memoryMiB: number
  ): { primary: string; alternatives: string[] } {
    const preferredFamily = determinePreferredFamily(cpuCount, memoryMiB);

    // Filter instances that can fit the workload
    const candidates = INSTANCE_CATALOG.filter(
      i => i.vCPU >= cpuCount && i.memoryMiB >= memoryMiB
    );

    if (candidates.length === 0) {
      // Fallback to largest available
      return {
        primary: 'm5.4xlarge',
        alternatives: ['r5.4xlarge', 'c5.4xlarge'],
      };
    }

    // Sort preferred family first, then by total resources (smallest fitting first)
    const sorted = [...candidates].sort((a, b) => {
      const aPreferred = a.family === preferredFamily ? 0 : 1;
      const bPreferred = b.family === preferredFamily ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      // Within same preference, pick smallest (cheapest)
      return a.hourlyRate - b.hourlyRate;
    });

    const primary = sorted[0];

    // Alternatives: next size up in same family, or best from different family
    const alternatives: string[] = [];

    // Next size up in same family
    const sameFamilyLarger = sorted.find(
      i => i.family === primary.family && i.hourlyRate > primary.hourlyRate
    );
    if (sameFamilyLarger) {
      alternatives.push(sameFamilyLarger.instanceType);
    }

    // Best from a different family
    const diffFamily = sorted.find(i => i.family !== primary.family);
    if (diffFamily) {
      alternatives.push(diffFamily.instanceType);
    }

    return {
      primary: primary.instanceType,
      alternatives: alternatives.slice(0, 2),
    };
  }

  /**
   * Analyze a VMware VM for migration to AWS EC2.
   */
  static analyzeVMwareForAWS(vmConfig: MigrationVMConfig): WorkloadAnalysis {
    const { primary, alternatives } = WorkloadAnalyzer.recommendInstanceType(
      vmConfig.cpuCount,
      vmConfig.memoryMiB
    );

    const primarySpec = WorkloadAnalyzer.getInstanceTypeSpecs(primary)!;
    const diskGB = totalDiskGB(vmConfig.disks);
    const ebsMonthlyCost = diskGB * EBS_GP3_COST_PER_GB;
    const instanceMonthlyCost = primarySpec.hourlyRate * HOURS_PER_MONTH;
    const totalMonthlyCost = instanceMonthlyCost + ebsMonthlyCost;

    const recommended: TargetRecommendation = {
      instanceType: primary,
      ebsVolumeType: 'gp3',
      estimatedMonthlyCost: Math.round(totalMonthlyCost * 100) / 100,
      notes: [
        `Maps ${vmConfig.cpuCount} vCPU / ${vmConfig.memoryMiB} MiB to ${primary}`,
        `${vmConfig.disks.length} disk(s) -> EBS gp3 volume(s), ${diskGB} GB total`,
      ],
    };

    const altRecommendations: TargetRecommendation[] = alternatives.map(alt => {
      const altSpec = WorkloadAnalyzer.getInstanceTypeSpecs(alt)!;
      const altMonthlyCost = altSpec.hourlyRate * HOURS_PER_MONTH + ebsMonthlyCost;
      return {
        instanceType: alt,
        ebsVolumeType: 'gp3',
        estimatedMonthlyCost: Math.round(altMonthlyCost * 100) / 100,
        notes: [
          `Alternative: ${alt} (${altSpec.vCPU} vCPU, ${altSpec.memoryMiB} MiB)`,
        ],
      };
    });

    // Build risks
    const risks: string[] = [
      'VMware Tools will not work on AWS - switch to SSM Agent',
    ];
    if (vmConfig.firmware === 'efi') {
      risks.push('Firmware type EFI may need Nitro instance');
    }
    if (vmConfig.nics.length > 1) {
      risks.push(
        `VM has ${vmConfig.nics.length} NICs - verify multi-ENI support on ${primary}`
      );
    }
    if (diskGB > 1000) {
      risks.push('Large disk footprint (>1TB) will increase migration time and EBS costs');
    }

    // Network considerations
    const networkConsiderations: string[] = [
      'VPC and subnet selection required before migration',
      'Security groups must be configured to match VMware firewall rules',
      'Elastic IP or NAT gateway needed for public access',
    ];
    if (vmConfig.nics.length > 1) {
      networkConsiderations.push(
        'Multiple NICs require multiple ENIs - check instance type ENI limits'
      );
    }

    // Migration time estimate: disk transfer + overhead
    const transferMinutes = (diskGB * 1024) / (TRANSFER_SPEED_MB_PER_SEC * 60);
    const migrationTimeEstimateMinutes = Math.ceil(transferMinutes + IMPORT_OVERHEAD_MINUTES);

    return {
      source: {
        provider: 'vmware-vsphere',
        vmName: vmConfig.name,
        config: vmConfig,
      },
      target: {
        provider: 'aws-ec2',
        recommended,
        alternatives: altRecommendations,
      },
      storage: {
        currentGB: diskGB,
        estimatedTargetGB: diskGB, // EBS uses same capacity
        format: 'vmdk', // source format
      },
      network: { considerations: networkConsiderations },
      costEstimate: {
        monthlyUSD: Math.round(totalMonthlyCost * 100) / 100,
        breakdown: {
          compute: Math.round(instanceMonthlyCost * 100) / 100,
          storage: Math.round(ebsMonthlyCost * 100) / 100,
        },
      },
      risks,
      migrationTimeEstimateMinutes,
    };
  }

  /**
   * Analyze an AWS EC2 instance for migration to VMware vSphere.
   */
  static analyzeAWSForVMware(
    instanceType: string,
    ebsVolumes: { sizeGB: number }[],
    platform?: string
  ): WorkloadAnalysis {
    const spec = WorkloadAnalyzer.getInstanceTypeSpecs(instanceType);
    const vCPU = spec?.vCPU ?? 2;
    const memoryMiB = spec?.memoryMiB ?? 4096;
    const guestOS = platformToGuestOS(platform);

    const diskGB = ebsVolumes.reduce((sum, v) => sum + v.sizeGB, 0);

    // Build a synthetic MigrationVMConfig for the source representation
    const sourceConfig: MigrationVMConfig = {
      name: `aws-${instanceType}`,
      cpuCount: vCPU,
      coresPerSocket: vCPU,
      memoryMiB,
      guestOS: platform ?? 'unknown',
      disks: ebsVolumes.map((v, i): MigrationDisk => ({
        label: `ebs-vol-${i}`,
        capacityBytes: v.sizeGB * 1024 * 1024 * 1024,
        sourcePath: `vol-${i}`,
        sourceFormat: 'raw',
        targetFormat: 'vmdk',
      })),
      nics: [
        {
          label: 'eth0',
          macAddress: '00:00:00:00:00:00',
          networkName: 'VM Network',
          adapterType: 'vmxnet3',
        },
      ],
      firmware: 'bios',
    };

    const recommended: TargetRecommendation = {
      cpuCount: vCPU,
      memoryMiB,
      guestOS,
      notes: [
        `Maps ${instanceType} (${vCPU} vCPU, ${memoryMiB} MiB) to vSphere VM`,
        `${ebsVolumes.length} EBS volume(s) -> VMDK disk(s), ${diskGB} GB total`,
        'VMware licensing costs are separate and not included in estimates',
      ],
    };

    // Provide an alternative with slightly more resources for headroom
    const altRecommendations: TargetRecommendation[] = [
      {
        cpuCount: vCPU * 2,
        memoryMiB: memoryMiB * 2,
        guestOS,
        notes: [
          `Oversized alternative: ${vCPU * 2} vCPU / ${memoryMiB * 2} MiB for extra headroom`,
        ],
      },
    ];

    const risks: string[] = [
      'AWS-specific features (instance store, placement groups) will not carry over',
      'User data scripts will not run on vSphere',
      'IAM instance profiles and roles are not available in VMware',
    ];
    if (spec === null) {
      risks.push(`Unknown instance type "${instanceType}" - specs were estimated`);
    }

    const networkConsiderations: string[] = [
      'Map AWS security groups to vSphere distributed firewall rules or NSX policies',
      'Configure vSphere port group to match VPC subnet requirements',
    ];

    const transferMinutes = (diskGB * 1024) / (TRANSFER_SPEED_MB_PER_SEC * 60);
    const migrationTimeEstimateMinutes = Math.ceil(transferMinutes + IMPORT_OVERHEAD_MINUTES);

    return {
      source: {
        provider: 'aws-ec2',
        vmName: `aws-${instanceType}`,
        config: sourceConfig,
      },
      target: {
        provider: 'vmware-vsphere',
        recommended,
        alternatives: altRecommendations,
      },
      storage: {
        currentGB: diskGB,
        estimatedTargetGB: diskGB,
        format: 'vmdk', // target format
      },
      network: { considerations: networkConsiderations },
      risks,
      migrationTimeEstimateMinutes,
    };
  }
}
