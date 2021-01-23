import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';
import { IndexComponent } from './index/index.component';
import { CvComponent } from './cv/cv.component';
import { ContactComponent } from './contact/contact.component';
import { ProjectsComponent } from './projects/projects.component';
import { CitizensappComponent } from './projects/citizensapp/citizensapp.component';
import { FarmersappComponent } from './projects/farmersapp/farmersapp.component';
import { ContentPusherComponent } from './projects/content-pusher/content-pusher.component';
import { PropertyManagementComponent } from './projects/property-management/property-management.component';
import { BlogsComponent } from './blogs/blogs.component';
import { ClassifierSelectorComponent } from './projects/classifier-selector/classifier-selector.component';
import { DroneDashComponent } from './projects/drone-dash/drone-dash.component';


const routes: Routes = [
  { path: '', component: IndexComponent },
  { path: 'cv', component: CvComponent },
  { path: 'contact', component: ContactComponent },
  { path: 'project', component: ProjectsComponent },
  { path: 'blogs', component: BlogsComponent },

  // Projects Urls here
  { path: 'citizensapp', component: CitizensappComponent },
  { path: 'farmersapp', component: FarmersappComponent },
  { path: 'blogger', component: ContentPusherComponent },
  { path: 'propertymanagement', component: PropertyManagementComponent },
  { path: 'dronedash', component: DroneDashComponent },
  { path: 'classifierSelector', component: ClassifierSelectorComponent }

];

@NgModule({
  imports: [RouterModule.forRoot(routes, { useHash: true })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
