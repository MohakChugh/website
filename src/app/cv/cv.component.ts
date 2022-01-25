import { Component, OnInit } from '@angular/core';
import html2pdf from 'html2pdf.js';

@Component({
  selector: 'app-cv',
  templateUrl: './cv.component.html',
  styleUrls: ['./cv.component.css']
})
export class CvComponent implements OnInit {

  constructor() { }

  ngOnInit(): void {
  }

  async generateCv() {
    console.log('Generate CV Function called!');
    const cvContent = document.getElementById('cv-content').innerHTML;
    // html2pdf(cvContent);
    const options = {
      margin:       1,
      filename:     'cv.pdf',
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2 },
      jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
    // save file as pdf
    await html2pdf().from(cvContent).set(options).save();

  }

}
