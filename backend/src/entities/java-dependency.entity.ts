import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('java_dependencies')
export class JavaDependency {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'from_file_id', type: 'integer' })
  from_file_id: number;

  @Column({ name: 'to_class_name', type: 'text' })
  to_class_name: string; // importierter Fully Qualified Name
}
