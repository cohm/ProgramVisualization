export interface CourseGroup {
  name: string;
  nameEn?: string;
  colorFamily: 'blue' | 'green' | 'turquoise' | 'brick' | 'yellow';
  courses: string[];
}

export interface ProgramCosmetics {
  groups: CourseGroup[];
  courseToGroup: Map<string, CourseGroup>;
}
