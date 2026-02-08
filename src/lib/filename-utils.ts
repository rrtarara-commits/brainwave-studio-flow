/**
 * Utilities for standardizing video filenames
 * Standard format: PROJECTCODE_VERSION_NUMBER (e.g., ABC123_v1)
 */

// Regex to match project code pattern: 3-4 letters + 3 numbers
const PROJECT_CODE_PATTERN = /^[A-Za-z]{3,4}\d{3}$/;

// Regex to extract version from filename (v1, v2, _v1, version1, rev1, r1)
const VERSION_PATTERNS = [
  /[_\-\s]?v(\d+)/i,
  /[_\-\s]?version[_\-\s]?(\d+)/i,
  /[_\-\s]?rev[_\-\s]?(\d+)/i,
  /[_\-\s]?r(\d+)(?![a-z])/i,
];

export interface FilenameAnalysis {
  isStandard: boolean;
  currentName: string;
  suggestedName: string | null;
  extension: string;
  extractedVersion: number | null;
  hasProjectCode: boolean;
}

/**
 * Validates if a project code matches the standard format
 * (3-4 letters followed by 3 numbers)
 */
export function isValidProjectCode(code: string): boolean {
  return PROJECT_CODE_PATTERN.test(code);
}

/**
 * Extracts version number from a filename
 */
export function extractVersionFromFilename(filename: string): number | null {
  for (const pattern of VERSION_PATTERNS) {
    const match = filename.match(pattern);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Checks if a filename already follows the standard format
 */
export function isStandardFilename(filename: string, projectCode: string): boolean {
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
  const pattern = new RegExp(`^${projectCode}_v\\d+$`, 'i');
  return pattern.test(nameWithoutExt);
}

/**
 * Generates a standardized filename
 */
export function generateStandardFilename(
  projectCode: string,
  version: number,
  extension: string
): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `${projectCode.toUpperCase()}_v${version}${ext}`;
}

/**
 * Analyzes a filename and suggests a standardized version
 */
export function analyzeFilename(
  currentFilename: string,
  projectCode: string | null
): FilenameAnalysis {
  const extension = currentFilename.includes('.')
    ? currentFilename.substring(currentFilename.lastIndexOf('.'))
    : '';
  
  const hasValidProjectCode = projectCode ? isValidProjectCode(projectCode) : false;
  
  if (!hasValidProjectCode || !projectCode) {
    return {
      isStandard: false,
      currentName: currentFilename,
      suggestedName: null,
      extension,
      extractedVersion: null,
      hasProjectCode: false,
    };
  }

  const isAlreadyStandard = isStandardFilename(currentFilename, projectCode);
  const extractedVersion = extractVersionFromFilename(currentFilename);
  
  // Default to v1 if no version found
  const versionToUse = extractedVersion || 1;
  const suggestedName = generateStandardFilename(projectCode, versionToUse, extension);

  return {
    isStandard: isAlreadyStandard,
    currentName: currentFilename,
    suggestedName: isAlreadyStandard ? null : suggestedName,
    extension,
    extractedVersion,
    hasProjectCode: true,
  };
}

/**
 * Gets the next version number based on existing uploads
 */
export function getNextVersion(existingFilenames: string[], projectCode: string): number {
  let maxVersion = 0;
  
  for (const filename of existingFilenames) {
    if (isStandardFilename(filename, projectCode)) {
      const version = extractVersionFromFilename(filename);
      if (version && version > maxVersion) {
        maxVersion = version;
      }
    }
  }
  
  return maxVersion + 1;
}
